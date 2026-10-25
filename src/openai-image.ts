import { ImageResponseError, readImageResponse } from './image-response.js';
import { queueImageGeneration, type ImageGenerationProgress } from './image-queue.js';
import type { ImageConnection } from './novelai.js';

export const OPENAI_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface OpenAIImageParameters {
  model: string;
  width: number;
  height: number;
  quality: typeof OPENAI_IMAGE_QUALITIES[number];
}

const OFFICIAL_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 46 * 1024 * 1024;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export function defaultOpenAIImageParameters(): OpenAIImageParameters {
  return { model: '', width: 1024, height: 1536, quality: 'auto' };
}

function fail(message: string): never { throw new ImageResponseError(message); }

export function validateOpenAIImageParameters(value: unknown, dimensions: 'request' | 'image' = 'request'): OpenAIImageParameters {
  const params = value as OpenAIImageParameters | null;
  if (!params || typeof params.model !== 'string' || params.model.length > 512 || /[\x00-\x1f\x7f]/.test(params.model)
    || ![params.width, params.height].every(size => Number.isInteger(size) && size >= (dimensions === 'image' ? 1 : 64)
      && size <= 4096 && (dimensions === 'image' || size % 16 === 0))
    || !OPENAI_IMAGE_QUALITIES.includes(params.quality)) {
    fail('GPT 生图参数无效，请检查模型、尺寸和质量设置。');
  }
  return { model: params.model.trim(), width: params.width, height: params.height, quality: params.quality };
}

/** Accept an API base or a complete generations endpoint without guessing other protocols. */
export function validateOpenAIImageConnection(connection: ImageConnection): ImageConnection {
  if (!connection || !['official', 'custom'].includes(connection.channel)) fail('请选择官方或自定义渠道。');
  const key = typeof connection.key === 'string' ? connection.key.trim().replace(/^Bearer\s+/i, '') : '';
  if (!key || /[^\x21-\x7e]/.test(key)) fail('请填写有效的 API 密钥。');
  if (connection.channel === 'official') return { channel: 'official', url: OFFICIAL_ENDPOINT, key };
  let url: URL;
  try { url = new URL(connection.url.trim()); }
  catch { return fail('请输入完整的自定义 URL，包含 https:// 或 http://。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    fail('GPT 生图 URL 仅支持不含账号、查询参数或锚点的 HTTP / HTTPS 网址。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/images/generations') ? path : `${path || '/v1'}/images/generations`;
  return { channel: 'custom', url: url.href, key };
}

async function withRequest<T>(signal: AbortSignal, timeout: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw new DOMException('本次请求已取消。', 'AbortError');
    if (timedOut) fail('接口响应超时，请确认服务端任务状态后再操作；没有自动重试。');
    if (error instanceof ImageResponseError) throw error;
    return fail('接口请求未完成，请检查网络、浏览器跨域限制和服务设置；没有自动重试。');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}

function requireSuccess(response: Response): void {
  if (response.ok) return;
  void response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) fail('密钥无效、已过期或没有接口权限。');
  if (response.status === 402) fail('接口额度不足，请检查账号。');
  if (response.status === 429) fail('接口请求过多或额度受限，请稍后手动重试。');
  fail(`接口请求失败（HTTP ${response.status}），请检查模型和参数；没有自动重试。`);
}

async function readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  requireSuccess(response);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    void response.body?.cancel().catch(() => {});
    fail('接口返回的数据超过允许大小。');
  }
  if (!response.body) fail('接口没有返回数据。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) fail('接口返回的数据超过允许大小。');
      chunks.push(chunk.value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const bytes = await readBytes(response, limit, signal);
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { return fail('接口没有返回有效 JSON，请检查 URL 是否为 API 地址。'); }
  if (!Object.keys(payload).length || payload.error) fail('接口返回了错误数据，请检查模型、额度和权限。');
  return payload;
}

export async function fetchOpenAIImageModels(connection: ImageConnection, signal: AbortSignal): Promise<string[]> {
  const configured = validateOpenAIImageConnection(connection);
  const url = new URL(configured.url);
  url.pathname = url.pathname.replace(/\/images\/generations$/, '/models');
  return withRequest(signal, 20_000, async requestSignal => {
    const response = await fetch(url.href, {
      headers: { Authorization: `Bearer ${configured.key}`, Accept: 'application/json' }, signal: requestSignal,
      mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    const payload = await readJson(response, 8 * 1024 * 1024, requestSignal);
    if (!Array.isArray(payload.data) || payload.data.length > 10_000) fail('模型列表格式无效或超过 10,000 项，请手动填写模型。');
    const models = payload.data.map(item => object(item).id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id));
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  });
}

async function imageBytes(item: Record<string, unknown>, signal: AbortSignal): Promise<Uint8Array> {
  if (typeof item.b64_json === 'string' && item.b64_json) {
    const source = item.b64_json;
    if (source.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || source.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) {
      fail('接口返回的 base64 图片无效或超过 32 MiB。');
    }
    let decoded: string;
    try { decoded = atob(source); }
    catch { return fail('接口返回的 base64 图片无法解码。'); }
    if (decoded.length > MAX_IMAGE_BYTES) fail('接口返回的图片超过 32 MiB。');
    signal.throwIfAborted();
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  }
  if (typeof item.url !== 'string' || !item.url) fail('接口没有返回 b64_json 或图片 URL。');
  let url: URL;
  try { url = new URL(item.url); }
  catch { return fail('接口返回的图片 URL 无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('接口返回的图片 URL 不受支持。');
  // Never forward the API credential, cookies or referrer to a returned image host.
  const response = await fetch(url.href, {
    signal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  return readBytes(response, MAX_IMAGE_BYTES, signal);
}

export async function generateOpenAIImage(
  connection: ImageConnection,
  parameters: OpenAIImageParameters,
  prompt: string,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<{ blob: Blob; parameters: OpenAIImageParameters }> {
  signal.throwIfAborted();
  const configured = validateOpenAIImageConnection(connection);
  const params = validateOpenAIImageParameters(parameters);
  if (!params.model) fail('请先填写或拉取生图模型名称。');
  if (/^gpt-image-2(?:\.5-(?:sunburst|flare))?(?:-|$)/.test(params.model)) {
    const area = params.width * params.height;
    if (Math.max(params.width, params.height) > 3840 || area < 655_360 || area > 8_294_400
      || params.width > params.height * 3 || params.height > params.width * 3) {
      fail('该 GPT Image 模型要求最长边不超过 3840、宽高比在 1:3 至 3:1 之间、总像素在 655,360 至 8,294,400 之间。');
    }
  }
  if (typeof prompt !== 'string' || !prompt.trim()) fail('请填写正面提示词。');
  const body = JSON.stringify({ model: params.model, prompt, n: 1, size: `${params.width}x${params.height}`, quality: params.quality, output_format: 'png' });
  return queueImageGeneration(() => withRequest(signal, 300_000, async requestSignal => {
    const response = await fetch(configured.url, {
      method: 'POST', headers: { Authorization: `Bearer ${configured.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body, signal: requestSignal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    const payload = await readJson(response, MAX_JSON_BYTES, requestSignal);
    if (!Array.isArray(payload.data) || payload.data.length !== 1) fail('生图接口应返回且仅返回一张图片。');
    const bytes = await imageBytes(object(payload.data[0]), requestSignal);
    if (!PNG_MAGIC.every((byte, index) => bytes[index] === byte)) fail('接口未按要求返回 PNG 图片，请检查服务兼容性。');
    const blob = await readImageResponse(new Response(Uint8Array.from(bytes).buffer), requestSignal, () => requestSignal.throwIfAborted());
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { blob, parameters: { ...params, width: header.getUint32(16), height: header.getUint32(20) } };
  }), signal, onProgress);
}
