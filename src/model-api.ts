import type { ModelApiSettings, ModelMessage, ModelRequestOptions, ModelTransport } from './model-types.js';

type JsonRecord = Record<string, unknown>;

interface TavernModelHost {
  mainApi: string;
  chatCompletionSettings: JsonRecord;
  getChatCompletionModel(settings: JsonRecord): string;
  getRequestHeaders(): HeadersInit;
  ChatCompletionService: {
    presetToGeneratePayload(preset: JsonRecord, overrides: JsonRecord, payload: JsonRecord): Promise<JsonRecord>;
  };
}

class ModelApiError extends Error {}

const responseLimit = 8 * 1024 * 1024;
const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const first = (value: unknown): JsonRecord => Array.isArray(value) ? record(value[0]) : {};

function customEndpoint(address: string, operation: 'models' | 'chat/completions'): string {
  let url: URL;
  try { url = new URL(address.trim()); }
  catch { throw new ModelApiError('请填写有效的 API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new ModelApiError('API 地址只支持不含账号、查询参数或锚点的 HTTP / HTTPS 网址。');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
  url.pathname = `${path || '/v1'}/${operation}`;
  return url.href;
}

function customHeaders(key: string): Headers {
  const normalized = key.trim().replace(/^Bearer\s+/i, '');
  if (/[^\x21-\x7e]/.test(normalized)) throw new ModelApiError('API 密钥包含空格或无效字符。');
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (normalized) headers.set('Authorization', `Bearer ${normalized}`);
  return headers;
}

async function withRequest<T>(
  signal: AbortSignal | undefined,
  timeout: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('请求已取消。', 'AbortError');
    if (timedOut) throw new ModelApiError('模型接口响应超时。');
    if (error instanceof ModelApiError) throw error;
    throw new ModelApiError('模型接口请求失败，请检查连接设置与接口的跨域支持。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

function parseJson(text: string): JsonRecord {
  try {
    const parsed = record(JSON.parse(text));
    if (!Object.keys(parsed).length || parsed.error) throw new Error();
    return parsed;
  } catch { throw new ModelApiError('模型接口返回了错误或无法解析的数据。'); }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.ok) throw new ModelApiError(`模型接口请求失败（HTTP ${response.status}）。`);
  if (!response.body) throw new ModelApiError('模型接口没有返回正文。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > responseLimit) throw new ModelApiError('模型接口返回的数据过大。');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only fetches the custom endpoint's model list; never changes the main Tavern connection. */
export async function fetchModelList(
  settings: Pick<ModelApiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<string[]> {
  const endpoint = customEndpoint(settings.url, 'models');
  const headers = customHeaders(settings.key);
  return withRequest(signal, 20_000, async requestSignal => {
    const response = await fetch(endpoint, {
      headers, signal: requestSignal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    const payload = parseJson(await readBody(response, requestSignal));
    if (!Array.isArray(payload.data)) throw new ModelApiError('模型列表格式不受支持，请手动填写模型名称。');
    const models = [...new Set(payload.data.map(item => record(item).id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 512))];
    if (models.length > 10_000) throw new ModelApiError('接口返回的模型列表过大，请手动填写模型名称。');
    return models.sort((a, b) => a.localeCompare(b));
  });
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    const item = record(part);
    return typeof item.text === 'string' && !item.thought && item.type !== 'thinking' ? item.text : '';
  }).join('');
}

function completeText(payload: JsonRecord): string {
  const choice = first(payload.choices);
  return contentText(record(choice.message).content) || contentText(choice.text)
    || contentText(payload.content) || contentText(record(payload.message).content)
    || contentText(record(first(payload.candidates).content).parts)
    || contentText(record(payload.responseContent).parts) || contentText(payload.text);
}

/** Compatible mode tolerates JSON bodies and SSE events containing a complete message. */
async function readCompletion(response: Response, mode: ModelTransport, options: ModelRequestOptions): Promise<string> {
  if (!response.ok) throw new ModelApiError(`模型接口请求失败（HTTP ${response.status}）。`);
  if (!response.body) throw new ModelApiError('模型接口没有返回正文。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let protocol: 'json' | 'sse' | null = null;
  let buffer = '';
  let text = '';
  let bytes = 0;
  let finished = false;
  let eventName = '';
  let eventData: string[] = [];
  const update = (next: string) => {
    if (next === text) return;
    text = next;
    options.onText?.(text);
  };
  const consumeEvent = () => {
    const data = eventData.join('\n');
    eventData = [];
    const name = eventName;
    eventName = '';
    if (name === 'error') throw new ModelApiError('模型接口返回了错误事件。');
    if (!data.trim()) return;
    if (data.trim() === '[DONE]') { finished = true; return; }
    const payload = parseJson(data);
    const choice = first(payload.choices);
    if (typeof choice.index === 'number' && choice.index > 0) return;
    const message = record(choice.message);
    if (Object.hasOwn(message, 'content')) update(contentText(message.content));
    else if (payload.type === 'message' && Array.isArray(payload.content)) update(contentText(payload.content));
    else {
      const delta = record(payload.delta);
      update(text + (contentText(record(choice.delta).content) || contentText(choice.text)
        || contentText(delta.text) || contentText(record(record(delta.message).content).text)
        || contentText(record(first(payload.candidates).content).parts)));
    }
  };
  const consumeLine = (line: string) => {
    if (!line) { consumeEvent(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') eventData.push(value);
  };
  const consume = (chunk: string, eof = false) => {
    buffer += chunk;
    if (!protocol) {
      const prefix = buffer.trimStart();
      if (prefix.startsWith('{')) protocol = 'json';
      else if (/^(?::|data:|event:|id:|retry:)/.test(prefix)) protocol = 'sse';
      else if (prefix && (eof || !['data:', 'event:', 'id:', 'retry:'].some(field => field.startsWith(prefix)))) {
        throw new ModelApiError('模型接口响应格式不受支持。');
      }
      if ((protocol === 'json' && mode === 'stream') || (protocol === 'sse' && mode === 'nonstream')) {
        throw new ModelApiError('接口返回格式与传输方式不符，请切换“假流兼容”。');
      }
    }
    if (protocol !== 'sse') return;
    while (!finished) {
      // Some relays send SSE heartbeats before an ordinary JSON completion.
      if (mode === 'compatible' && !eventData.length && !text && buffer.trimStart().startsWith('{')) {
        protocol = 'json';
        return;
      }
      const ending = /\r\n|\r|\n/.exec(buffer);
      if (!ending || (!eof && ending[0] === '\r' && ending.index === buffer.length - 1)) break;
      consumeLine(buffer.slice(0, ending.index));
      buffer = buffer.slice(ending.index + ending[0].length);
    }
    if (eof && !finished) {
      if (buffer) consumeLine(buffer);
      buffer = '';
      consumeEvent();
    }
  };
  try {
    while (!finished) {
      options.signal?.throwIfAborted();
      const chunk = await reader.read();
      options.signal?.throwIfAborted();
      if (chunk.done) { consume(decoder.decode(), true); break; }
      bytes += chunk.value.byteLength;
      if (bytes > responseLimit) throw new ModelApiError('模型接口返回的数据过大。');
      consume(decoder.decode(chunk.value, { stream: true }));
    }
    if (protocol === 'json') update(completeText(parseJson(buffer)));
    if (!text.trim()) throw new ModelApiError('模型接口没有返回文本正文。');
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function tavernHost(): TavernModelHost {
  const root = globalThis as typeof globalThis & { SillyTavern?: { getContext(): unknown } };
  const host = record(root.SillyTavern?.getContext());
  if (host.mainApi !== 'openai') {
    throw new ModelApiError('跟随酒馆主 API 目前支持“聊天补全”；请切换主 API 类型或使用自定义接口。');
  }
  const service = host.ChatCompletionService as Partial<TavernModelHost['ChatCompletionService']> | undefined;
  if (typeof service?.presetToGeneratePayload !== 'function'
    || typeof host.getRequestHeaders !== 'function' || typeof host.getChatCompletionModel !== 'function'
    || !host.chatCompletionSettings) {
    throw new ModelApiError('当前酒馆版本未提供独立模型请求接口，请升级酒馆或使用自定义接口。');
  }
  return host as unknown as TavernModelHost;
}

/** Makes one isolated request using only the caller's messages; no chat history or prompts are added here. */
export async function requestModel(
  settings: ModelApiSettings,
  messages: readonly ModelMessage[],
  options: ModelRequestOptions = {},
): Promise<string> {
  if (!Number.isInteger(settings.maxTokens) || settings.maxTokens < 1 || settings.maxTokens > 65536
    || !Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2
    || !['tavern', 'custom'].includes(settings.mode)
    || !['nonstream', 'stream', 'compatible'].includes(settings.transport)) {
    throw new ModelApiError('请检查模型参数。');
  }
  if (!messages.length
    || messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
    || !messages.some(message => message.content.trim())) {
    throw new ModelApiError('没有可发送的有效预设或功能层内容。');
  }
  const stream = settings.transport !== 'nonstream';
  const copiedMessages = messages.map(({ role, content }) => ({ role, content }));
  return withRequest(options.signal, 300_000, async signal => {
    let endpoint: string;
    let headers: HeadersInit;
    let payload: JsonRecord;
    if (settings.mode === 'custom') {
      if (!settings.model.trim()) throw new ModelApiError('请填写模型名称。');
      endpoint = customEndpoint(settings.url, 'chat/completions');
      headers = customHeaders(settings.key);
      payload = {
        model: settings.model.trim(), messages: copiedMessages, stream,
        max_tokens: settings.maxTokens, temperature: settings.temperature,
      };
    } else {
      const host = tavernHost();
      const model = host.getChatCompletionModel(host.chatCompletionSettings);
      if (!model) throw new ModelApiError('请先在酒馆主 API 中选择模型。');
      endpoint = '/api/backends/chat-completions/generate';
      headers = host.getRequestHeaders();
      payload = await host.ChatCompletionService.presetToGeneratePayload({}, {
        openai_max_tokens: settings.maxTokens, temperature: settings.temperature,
        function_calling: false, enable_web_search: false, request_images: false,
      }, { model, messages: copiedMessages, stream });
      // Keep text and its ordering controlled by this extension's preset and feature layers.
      for (const key of ['tools', 'tool_choice', 'custom_include_body', 'custom_exclude_body', 'assistant_prefill']) {
        delete payload[key];
      }
    }
    signal.throwIfAborted();
    const response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload), signal,
      credentials: settings.mode === 'tavern' ? 'same-origin' : 'omit',
      redirect: 'error', referrerPolicy: 'no-referrer',
    });
    return readCompletion(response, settings.transport, { ...options, signal });
  });
}
