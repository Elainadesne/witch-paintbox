import { decodeImageBase64 } from './image-bytes.js';
import { ImageResponseError } from './image-response.js';
import { readRasterImage } from './raster-image.js';
import { queueImageGeneration, type ImageGenerationProgress } from './image-queue.js';
import type { ImageConnection } from './novelai.js';
import type { PetFault } from './pet-events.js';

export const OPENAI_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const OPENAI_IMAGE_COMPLEXITIES = ['default', 'low', 'medium', 'high'] as const;
export const OPENAI_IMAGE_26_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const;

export function supportsOpenAIImageComplexity(model: string): boolean {
  return OPENAI_IMAGE_26_MODELS.some(value => value === model.trim());
}

export function openAIImageComplexityLabel(value: OpenAIImageParameters['complexity']): string {
  return { default: '跟随模型（未指定）', low: '低 · low', medium: '中 · medium', high: '高 · high' }[value];
}

export function openAIImageComplexityHint(model: string): string {
  return supportsOpenAIImageComplexity(model)
    ? 'complexity 用来定画前构思有多细，和画质分开算。选“跟随模型”就不额外传它，GPT Image 2.6 官方默认是高；开得越高画前想得越久。'
    : '选了 GPT Image 2.6 Flare 或 Sunburst 才能调这一档。现在这个模型不会发 complexity 过去；选好的值会留着，以后切回 2.6 马上生效。';
}

export interface OpenAIImageParameters {
  model: string;
  width: number;
  height: number;
  quality: typeof OPENAI_IMAGE_QUALITIES[number];
  complexity: typeof OPENAI_IMAGE_COMPLEXITIES[number];
}

const OFFICIAL_ENDPOINT = 'https://api.openai.com/v1/images/generations';
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_JSON_BYTES = 46 * 1024 * 1024;

export function defaultOpenAIImageParameters(): OpenAIImageParameters {
  return { model: '', width: 1024, height: 1536, quality: 'auto', complexity: 'default' };
}

export function fail(message: string, fault?: PetFault): never { throw new ImageResponseError(message, fault); }

export function validateOpenAIImageParameters(value: unknown, dimensions: 'request' | 'image' = 'request'): OpenAIImageParameters {
  const params = value as OpenAIImageParameters | null;
  if (!params || typeof params.model !== 'string' || params.model.length > 512 || /[\x00-\x1f\x7f]/.test(params.model)
    || ![params.width, params.height].every(size => Number.isInteger(size) && size >= (dimensions === 'image' ? 1 : 64)
      && size <= 4096 && (dimensions === 'image' || size % 16 === 0))
    || !OPENAI_IMAGE_QUALITIES.includes(params.quality)
    || params.complexity !== undefined && !OPENAI_IMAGE_COMPLEXITIES.includes(params.complexity)) {
    fail('GPT 这套生图参数没填对，核对一下模型名、尺寸、画质和规划深度。', 'setup');
  }
  return { model: params.model.trim(), width: params.width, height: params.height, quality: params.quality,
    complexity: params.complexity ?? 'default' };
}

/** Accept an API base or a complete generations endpoint without guessing other protocols. */
export function validateOpenAIImageConnection(connection: ImageConnection, officialEndpoint = OFFICIAL_ENDPOINT): ImageConnection {
  if (!connection || !['official', 'custom'].includes(connection.channel)) fail('先选一下用官方渠道还是自定义接口。', 'setup');
  const key = typeof connection.key === 'string' ? connection.key.trim().replace(/^Bearer\s+/i, '') : '';
  if (!key || /[^\x21-\x7e]/.test(key)) fail('API 密钥没填，或者里面夹了空格和非法字符。', 'setup');
  const { appendSuffix } = connection;
  if (connection.channel === 'official') return { channel: 'official', url: officialEndpoint, key, appendSuffix };
  let url: URL;
  try { url = new URL(connection.url.trim()); }
  catch { return fail('自定义地址得写完整，把 https:// 或 http:// 带上。', 'setup'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    fail('生图地址只认干净的 HTTP / HTTPS 网址，不能带账号密码、查询参数或 # 锚点。', 'setup');
  }
  if (appendSuffix) {
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/images/generations') ? path : `${path || '/v1'}/images/generations`;
  }
  return { channel: 'custom', url: appendSuffix ? url.href : connection.url.trim(), key, appendSuffix };
}

export async function withRequest<T>(signal: AbortSignal, timeout: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
    if (timedOut) fail('等太久接口没回话，免得重复扣费先停下了；确认下对面服务端状况再重发吧。', 'timeout');
    if (error instanceof ImageResponseError) throw error;
    return fail('请求中途断了，看看网络、服务地址或者是不是被浏览器跨域拦了；没有自动重试。', 'network');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}

function requireSuccess(response: Response): void {
  if (response.ok) return;
  void response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) fail('密钥不对、过期了，或者没开通这个接口权限。', 'auth');
  if (response.status === 402) fail('账号额度不够啦，看一眼余额吧。', 'quota');
  if (response.status === 429) fail('请求太密或者额度卡住了，稍等一会儿再自己重试。', 'busy');
  fail(`请求没过（HTTP ${response.status}），看看模型名和参数写对没；为了省额度没自动重试。`, 'unknown');
}

export async function readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  requireSuccess(response);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    void response.body?.cancel().catch(() => {});
    fail('对面传回来的数据太大了，没敢接着收。');
  }
  if (!response.body) fail('接口回了个空响应，什么数据都没给。');
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
      if (bytes > limit) fail('对面传回来的数据太大了，停下读取。');
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

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const bytes = await readBytes(response, limit, signal);
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { return fail('接口回的不是合法 JSON，核对下填的 URL 对不对。'); }
  if (!Object.keys(payload).length || payload.error) fail('接口报了错，看看模型名、额度和权限都有没有问题。');
  return payload;
}

export async function fetchOpenAIImageModels(connection: ImageConnection, signal: AbortSignal, officialEndpoint = OFFICIAL_ENDPOINT): Promise<string[]> {
  const configured = validateOpenAIImageConnection(connection, officialEndpoint);
  const url = new URL(configured.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/images/generations')) {
    fail('按现在填的完整地址推不出模型列表入口，直接手填模型名吧。', 'setup');
  }
  url.pathname = path.replace(/\/images\/generations$/, '/models');
  return withRequest(signal, 20_000, async requestSignal => {
    const response = await fetch(url.href, {
      headers: { Authorization: `Bearer ${configured.key}`, Accept: 'application/json' }, signal: requestSignal,
      mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    const payload = await readJson(response, 8 * 1024 * 1024, requestSignal);
    if (!Array.isArray(payload.data) || payload.data.length > 10_000) fail('拉回来的模型列表格式不对（或者超过 10,000 个了），自己手填模型名吧。');
    const models = payload.data.map(item => object(item).id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id));
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  });
}

export async function imageBytes(item: Record<string, unknown>, signal: AbortSignal): Promise<Uint8Array> {
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) return decodeImageBase64(item.b64_json, signal);
  if (typeof item.url !== 'string' || !item.url) fail('响应里既没带 b64_json 图片数据，也没有图片链接。');
  if (/^data:/i.test(item.url.trim())) return decodeImageBase64(item.url, signal);
  let url: URL;
  try { url = new URL(item.url); }
  catch { return fail('对面给的图片链接不对劲，打不开。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('对面传回来的图片地址带了不支持的协议或账号参数。');
  // Never forward the API credential, cookies or referrer to a returned image host.
  const response = await fetch(url.href, {
    signal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  return readBytes(response, MAX_IMAGE_BYTES, signal);
}

/** POST one OpenAI-shaped generations request and decode its single image. */
export async function postImagesGeneration(
  configured: ImageConnection,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<{ blob: Blob; width: number; height: number }> {
  const json = JSON.stringify(body);
  return queueImageGeneration(() => withRequest(signal, 300_000, async requestSignal => {
    const response = await fetch(configured.url, {
      method: 'POST', headers: { Authorization: `Bearer ${configured.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: json, signal: requestSignal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    const payload = await readJson(response, MAX_JSON_BYTES, requestSignal);
    if (!Array.isArray(payload.data) || payload.data.length !== 1) fail('每次请求需要正好返回一张图，这次的数量对不上。');
    const bytes = await imageBytes(object(payload.data[0]), requestSignal);
    const image = await readRasterImage(bytes, requestSignal);
    return { blob: image.blob, width: image.width, height: image.height };
  }), signal, onProgress);
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
  if (!params.model) fail('先填一个或者刷新拉取一个生图模型名吧。', 'setup');
  if (/^gpt-image-2(?:\.[56]-(?:sunburst|flare))?(?:-|$)/.test(params.model)) {
    const area = params.width * params.height;
    if (Math.max(params.width, params.height) > 3840 || area < 655_360 || area > 8_294_400
      || params.width > params.height * 3 || params.height > params.width * 3) {
      fail('这个 GPT Image 模型的尺寸有限制：最长边不能过 3840，比例得在 1:3 到 3:1 之间，总像素要在 655,360 到 8,294,400 之间。', 'setup');
    }
  }
  if (typeof prompt !== 'string' || !prompt.trim()) fail('正面提示词还是空的，写点东西再画。', 'setup');
  // Keep a saved 2.6 choice when switching models, but record only what this request can send.
  if (!supportsOpenAIImageComplexity(params.model)) params.complexity = 'default';
  const body = { model: params.model, prompt, n: 1, size: `${params.width}x${params.height}`, quality: params.quality, output_format: 'png',
    ...(params.complexity === 'default' ? {} : { complexity: params.complexity }) };
  const image = await postImagesGeneration(configured, body, signal, onProgress);
  return { blob: image.blob, parameters: { ...params, width: image.width, height: image.height } };
}
