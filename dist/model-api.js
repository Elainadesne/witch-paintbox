class ModelApiError extends Error {
    fault;
    constructor(message, fault = 'format') {
        super(message);
        this.fault = fault;
    }
}
const statusFault = (status) => status === 401 || status === 403 ? 'auth' : status === 402 ? 'quota' : status === 429 ? 'busy' : 'unknown';
const responseLimit = 8 * 1024 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const first = (value) => Array.isArray(value) ? record(value[0]) : {};
function customBaseUrl(address) {
    let url;
    try {
        url = new URL(address.trim());
    }
    catch {
        throw new ModelApiError('请填写有效的 API 地址。', 'setup');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw new ModelApiError('API 地址只支持不含账号、查询参数或锚点的 HTTP / HTTPS 网址。', 'setup');
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
    url.pathname = path || '/v1';
    return url.href.replace(/\/$/, '');
}
function customConnection(settings) {
    const normalized = settings.key.trim().replace(/^Bearer\s+/i, '');
    if (/[^\x21-\x7e]/.test(normalized))
        throw new ModelApiError('API 密钥包含空格或无效字符。', 'setup');
    return {
        chat_completion_source: 'custom',
        custom_url: customBaseUrl(settings.url),
        // The backend merges these after its saved CUSTOM credential. An empty value
        // also prevents falling back to another connection's stored API key.
        custom_include_headers: JSON.stringify({ Authorization: normalized ? `Bearer ${normalized}` : '' }),
        custom_prompt_post_processing: 'none',
    };
}
function tavernContext() {
    const root = globalThis;
    return record(root.SillyTavern?.getContext());
}
function requestHeaders(host = tavernContext()) {
    if (typeof host.getRequestHeaders !== 'function')
        throw new ModelApiError('当前环境未提供酒馆后端连接。', 'setup');
    return host.getRequestHeaders();
}
async function withRequest(signal, timeout, operation) {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted)
        cancel();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
        controller.signal.throwIfAborted();
        return await operation(controller.signal);
    }
    catch (error) {
        if (signal?.aborted)
            throw new DOMException('请求已取消。', 'AbortError');
        if (timedOut)
            throw new ModelApiError('模型接口响应超时。', 'timeout');
        if (error instanceof ModelApiError)
            throw error;
        throw new ModelApiError('模型接口请求失败，请检查连接设置与酒馆后端连接。', 'network');
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
    }
}
function parseJson(text) {
    try {
        const parsed = JSON.parse(text);
        const items = (Array.isArray(parsed) ? parsed : [parsed]).map(record);
        if (!items.length || items.some(item => !Object.keys(item).length || item.error))
            throw new Error();
        return Array.isArray(parsed) ? items : items[0];
    }
    catch {
        throw new ModelApiError('模型接口返回了错误或无法解析的数据。');
    }
}
async function readBody(response, signal) {
    if (!response.ok)
        throw new ModelApiError(`模型接口请求失败（HTTP ${response.status}）。`, statusFault(response.status));
    if (!response.body)
        throw new ModelApiError('模型接口没有返回正文。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done)
                return text + decoder.decode();
            bytes += chunk.value.byteLength;
            if (bytes > responseLimit)
                throw new ModelApiError('模型接口返回的数据过大。');
            text += decoder.decode(chunk.value, { stream: true });
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/** Only fetches the custom endpoint's model list; never changes the main Tavern connection. */
export async function fetchModelList(settings, signal) {
    const connection = customConnection(settings);
    const headers = requestHeaders();
    return withRequest(signal, 20_000, async (requestSignal) => {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST', headers, body: JSON.stringify(connection), signal: requestSignal,
            credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
        });
        const payload = record(parseJson(await readBody(response, requestSignal)));
        if (!Array.isArray(payload.data))
            throw new ModelApiError('模型列表格式不受支持，请手动填写模型名称。');
        const models = [...new Set(payload.data.map(item => record(item).id)
                .filter((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 512))];
        if (models.length > 10_000)
            throw new ModelApiError('接口返回的模型列表过大，请手动填写模型名称。');
        return models.sort((a, b) => a.localeCompare(b));
    });
}
function contentText(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return '';
    return value.map(part => {
        const item = record(part);
        return typeof item.text === 'string' && !item.thought && item.type !== 'thinking' ? item.text : '';
    }).join('');
}
/** Compatible mode tolerates JSON bodies and SSE events containing a complete message. */
async function readCompletion(response, mode, options) {
    if (!response.ok)
        throw new ModelApiError(`模型接口请求失败（HTTP ${response.status}）。`, statusFault(response.status));
    if (!response.body)
        throw new ModelApiError('模型接口没有返回正文。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let protocol = null;
    let buffer = '';
    let text = '';
    let bytes = 0;
    let finished = false;
    let eventName = '';
    let eventData = [];
    const update = (next) => {
        if (next === text)
            return;
        text = next;
        if (mode === 'stream')
            options.onText?.(text);
    };
    const consumePayload = (payload) => {
        const choice = first(payload.choices);
        if (typeof choice.index === 'number' && choice.index > 0)
            return;
        const snapshot = contentText(record(choice.message).content)
            || contentText(payload.content) || contentText(record(payload.message).content)
            || contentText(record(payload.responseContent).parts) || contentText(payload.text);
        // Like folkloreTransport, an empty terminal snapshot must not erase received text.
        if (snapshot.trim()) {
            update(snapshot);
            return;
        }
        const delta = record(payload.delta);
        update(text + (contentText(record(choice.delta).content) || contentText(choice.text)
            || contentText(delta.text) || contentText(record(record(delta.message).content).text)
            || contentText(record(first(payload.candidates).content).parts)));
    };
    const consumePayloads = (data) => {
        const parsed = parseJson(data);
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(consumePayload);
    };
    const consumeEvent = () => {
        const data = eventData.join('\n');
        eventData = [];
        const name = eventName;
        eventName = '';
        if (name === 'error')
            throw new ModelApiError('模型接口返回了错误事件。');
        if (!data.trim())
            return;
        if (data.trim() === '[DONE]') {
            finished = true;
            return;
        }
        consumePayloads(data);
    };
    const consumeLine = (line) => {
        if (!line) {
            consumeEvent();
            return;
        }
        if (line.startsWith(':'))
            return;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event')
            eventName = value;
        else if (field === 'data')
            eventData.push(value);
    };
    const consume = (chunk, eof = false) => {
        buffer += chunk;
        if (!protocol) {
            const prefix = buffer.trimStart();
            if (prefix.startsWith('{') || prefix.startsWith('['))
                protocol = 'json';
            else if (/^(?::|data:|event:|id:|retry:)/.test(prefix)) {
                protocol = 'sse';
                buffer = prefix;
            }
            else if (prefix && (eof || !['data:', 'event:', 'id:', 'retry:'].some(field => field.startsWith(prefix)))) {
                throw new ModelApiError('模型接口响应格式不受支持。');
            }
            if ((protocol === 'json' && mode === 'stream') || (protocol === 'sse' && mode === 'nonstream')) {
                throw new ModelApiError('接口返回格式与传输方式不符，请切换“假流兼容”。');
            }
        }
        if (protocol !== 'sse')
            return;
        while (!finished) {
            // Some relays send SSE heartbeats before an ordinary JSON completion.
            if (mode === 'compatible' && !eventData.length && !text && /^[{\[]/.test(buffer.trimStart())) {
                protocol = 'json';
                return;
            }
            const ending = /\r\n|\r|\n/.exec(buffer);
            if (!ending || (!eof && ending[0] === '\r' && ending.index === buffer.length - 1))
                break;
            consumeLine(buffer.slice(0, ending.index));
            buffer = buffer.slice(ending.index + ending[0].length);
        }
        if (eof && !finished) {
            if (buffer)
                consumeLine(buffer);
            buffer = '';
            consumeEvent();
        }
    };
    const abortReader = () => { void reader.cancel().catch(() => { }); };
    options.signal?.addEventListener('abort', abortReader, { once: true });
    try {
        while (!finished) {
            options.signal?.throwIfAborted();
            const chunk = await reader.read();
            options.signal?.throwIfAborted();
            if (chunk.done) {
                consume(decoder.decode(), true);
                break;
            }
            bytes += chunk.value.byteLength;
            if (bytes > responseLimit)
                throw new ModelApiError('模型接口返回的数据过大。');
            consume(decoder.decode(chunk.value, { stream: true }));
        }
        options.signal?.throwIfAborted();
        if (protocol === 'json')
            consumePayloads(buffer);
        if (!text.trim())
            throw new ModelApiError('模型接口没有返回文本正文。');
        if (mode !== 'stream')
            options.onText?.(text);
        return text;
    }
    finally {
        options.signal?.removeEventListener('abort', abortReader);
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
function tavernHost() {
    const host = tavernContext();
    if (host.mainApi !== 'openai') {
        throw new ModelApiError('跟随酒馆主 API 目前支持“聊天补全”；请切换主 API 类型或使用自定义接口。', 'setup');
    }
    const service = host.ChatCompletionService;
    if (typeof service?.presetToGeneratePayload !== 'function'
        || typeof host.getRequestHeaders !== 'function' || typeof host.getChatCompletionModel !== 'function'
        || !host.chatCompletionSettings) {
        throw new ModelApiError('当前酒馆版本未提供独立模型请求接口，请升级酒馆或使用自定义接口。', 'setup');
    }
    return host;
}
/** Makes one isolated request using only the caller's messages; no chat history or prompts are added here. */
export async function requestModel(settings, messages, options = {}) {
    if (!Number.isInteger(settings.maxTokens) || settings.maxTokens < 1 || settings.maxTokens > 65536
        || !Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2
        || !['tavern', 'custom'].includes(settings.mode)
        || !['nonstream', 'stream', 'compatible'].includes(settings.transport)) {
        throw new ModelApiError('请检查模型参数。', 'setup');
    }
    if (!messages.length
        || messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
        || !messages.some(message => message.content.trim())) {
        throw new ModelApiError('没有可发送的有效预设或功能层内容。', 'setup');
    }
    const stream = settings.transport !== 'nonstream';
    const copiedMessages = messages.map(({ role, content }) => ({ role, content }));
    return withRequest(options.signal, 300_000, async (signal) => {
        const endpoint = '/api/backends/chat-completions/generate';
        let headers;
        let payload;
        if (settings.mode === 'custom') {
            if (!settings.model.trim())
                throw new ModelApiError('请填写模型名称。', 'setup');
            headers = requestHeaders();
            payload = {
                ...customConnection(settings),
                model: settings.model.trim(), messages: copiedMessages, stream,
                max_tokens: settings.maxTokens, temperature: settings.temperature,
            };
        }
        else {
            const host = tavernHost();
            const model = host.getChatCompletionModel(host.chatCompletionSettings);
            if (!model)
                throw new ModelApiError('请先在酒馆主 API 中选择模型。', 'setup');
            headers = host.getRequestHeaders();
            payload = await host.ChatCompletionService.presetToGeneratePayload({}, {
                openai_max_tokens: settings.maxTokens, temperature: settings.temperature,
                function_calling: false, enable_web_search: false, request_images: false,
            }, { model, messages: copiedMessages, stream });
            // Keep text and its ordering controlled by this extension's preset and feature layers.
            for (const key of ['tools', 'tool_choice', 'custom_include_body', 'custom_exclude_body', 'assistant_prefill']) {
                delete payload[key];
            }
            payload.custom_prompt_post_processing = 'none';
        }
        signal.throwIfAborted();
        const response = await fetch(endpoint, {
            method: 'POST', headers, body: JSON.stringify(payload), signal,
            credentials: 'same-origin',
            redirect: 'error', referrerPolicy: 'no-referrer',
        });
        return readCompletion(response, settings.transport, { ...options, signal });
    });
}
