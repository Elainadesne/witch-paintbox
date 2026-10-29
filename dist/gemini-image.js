import { decodeImageBase64 } from './image-bytes.js';
import { queueImageGeneration } from './image-queue.js';
import { readRasterImage } from './raster-image.js';
import { fail, imageBytes, MAX_JSON_BYTES, object, postImagesGeneration, readJson, validateOpenAIImageConnection, withRequest, } from './openai-image.js';
import { geminiFixedTier, ratioToOpenAISize, validateGeminiImageParameters } from './aspect-image.js';
const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
function cleanKey(connection) {
    const key = typeof connection.key === 'string' ? connection.key.trim().replace(/^Bearer\s+/i, '') : '';
    if (!key || /[^\x21-\x7e]/.test(key))
        fail('请填写有效的 API 密钥。', 'setup');
    return key;
}
function customUrl(connection) {
    let url;
    try {
        url = new URL(connection.url.trim());
    }
    catch {
        return fail('请输入完整的自定义 URL，包含 https:// 或 http://。', 'setup');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        fail('生图 URL 仅支持不含账号、查询参数或锚点的 HTTP / HTTPS 网址。', 'setup');
    }
    return url;
}
function modelPath(model) {
    const name = model.trim().replace(/^models\//, '');
    if (!/^[A-Za-z0-9._-]+$/.test(name))
        fail('Gemini 模型名称只能包含字母、数字、点、下划线和连字符。', 'setup');
    return name;
}
/** Resolve the request URL for one protocol; custom paths are kept when suffixing is off. */
export function geminiEndpoint(connection, params) {
    const official = connection.channel === 'official';
    if (params.protocol === 'interactions') {
        if (official)
            return `${GEMINI_ORIGIN}/v1beta/interactions`;
        const url = customUrl(connection);
        if (!connection.appendSuffix)
            return connection.url.trim();
        const path = url.pathname.replace(/\/+$/, '');
        url.pathname = /\/interactions$/.test(path) ? path : `${path.replace(/\/v1beta$/, '')}/v1beta/interactions`;
        return url.href;
    }
    const model = modelPath(params.model);
    if (official)
        return `${GEMINI_ORIGIN}/v1beta/models/${model}:generateContent`;
    const url = customUrl(connection);
    if (!connection.appendSuffix)
        return connection.url.trim();
    const path = url.pathname.replace(/\/+$/, '');
    if (/:generateContent$/.test(path))
        return url.href;
    url.pathname = `${path.replace(/\/v1beta$/, '')}/v1beta/models/${model}:generateContent`;
    return url.href;
}
export function geminiRequestBody(params, prompt) {
    const tier = geminiFixedTier(params.model);
    const size = tier === 'omit' ? undefined : tier ?? params.imageSize;
    if (params.protocol === 'interactions') {
        return {
            model: params.model.trim().replace(/^models\//, ''),
            input: [{ type: 'text', text: prompt }],
            response_format: { type: 'image', aspect_ratio: params.aspectRatio, ...(size ? { image_size: size } : {}) },
        };
    }
    if (params.protocol === 'generateContent') {
        return {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: params.aspectRatio, ...(size ? { imageSize: size } : {}) } },
        };
    }
    return { model: params.model, prompt, n: 1, size: ratioToOpenAISize(params.aspectRatio), aspect_ratio: params.aspectRatio, response_format: 'b64_json' };
}
function imageData(block) {
    const inline = object(block.inlineData ?? block.inline_data);
    if (typeof inline.data === 'string' && inline.data)
        return inline.data;
    if (block.type === 'image' && typeof block.data === 'string' && block.data)
        return block.data;
    return null;
}
/** Interactions REST returns steps; SDK-style payloads expose output_image; legacy returns candidates. */
export function geminiImagePayload(payload) {
    const convenience = object(payload.output_image);
    if (typeof convenience.data === 'string' && convenience.data)
        return convenience.data;
    const found = [];
    for (const list of [payload.steps, payload.outputs]) {
        if (!Array.isArray(list))
            continue;
        for (const step of list.map(object)) {
            if (step.type !== undefined && step.type !== 'model_output')
                continue;
            const content = Array.isArray(step.content) ? step.content : [step];
            for (const block of content.map(object)) {
                const data = imageData(block);
                if (data)
                    found.push(data);
            }
        }
    }
    const candidates = Array.isArray(payload.candidates) ? payload.candidates.map(object) : [];
    for (const candidate of candidates) {
        const parts = object(candidate.content).parts;
        if (Array.isArray(parts))
            for (const part of parts.map(object)) {
                const data = imageData(part);
                if (data)
                    found.push(data);
            }
    }
    if (found.length)
        return found[found.length - 1];
    if (Array.isArray(payload.data) && payload.data.length === 1)
        return object(payload.data[0]);
    const reason = typeof object(candidates[0]).finishReason === 'string' ? `（${object(candidates[0]).finishReason}）` : '';
    return fail(`Gemini 没有返回图片${reason}，可能被安全策略拦截或模型不支持出图。`);
}
export async function generateGeminiImage(connection, parameters, prompt, signal, onProgress) {
    signal.throwIfAborted();
    if (!connection || !['official', 'custom'].includes(connection.channel))
        fail('请选择官方或自定义渠道。', 'setup');
    const params = validateGeminiImageParameters(parameters, () => fail('Gemini 生图参数无效，请检查协议、模型、比例和分辨率。', 'setup'));
    if (!params.model)
        fail('请先填写或选择生图模型名称。', 'setup');
    if (typeof prompt !== 'string' || !prompt.trim())
        fail('请填写正面提示词。', 'setup');
    if (params.protocol === 'openai') {
        if (connection.channel === 'official')
            fail('Google 官方接口不提供 OpenAI 兼容出图，请改选 Interactions 或 generateContent 协议。', 'setup');
        const configured = validateOpenAIImageConnection(connection);
        const image = await postImagesGeneration(configured, geminiRequestBody(params, prompt), signal, onProgress);
        return { blob: image.blob, parameters: params, width: image.width, height: image.height };
    }
    const key = cleanKey(connection);
    const url = geminiEndpoint(connection, params);
    const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' };
    // Relays usually accept a bearer token; Google's own endpoint only needs x-goog-api-key.
    if (connection.channel === 'custom')
        headers.Authorization = `Bearer ${key}`;
    const body = JSON.stringify(geminiRequestBody(params, prompt));
    return queueImageGeneration(() => withRequest(signal, 300_000, async (requestSignal) => {
        const response = await fetch(url, {
            method: 'POST', headers, body, signal: requestSignal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        });
        const payload = await readJson(response, MAX_JSON_BYTES, requestSignal);
        const found = geminiImagePayload(payload);
        const bytes = typeof found === 'string' ? await decodeImageBase64(found, requestSignal) : await imageBytes(found, requestSignal);
        const image = await readRasterImage(bytes, requestSignal);
        return { blob: image.blob, parameters: params, width: image.width, height: image.height };
    }), signal, onProgress);
}
/** Google lists models at /v1beta/models; keep only image-capable names. */
export async function fetchGeminiImageModels(connection, params, signal) {
    if (params.protocol === 'openai') {
        const { fetchOpenAIImageModels } = await import('./openai-image.js');
        return fetchOpenAIImageModels(connection, signal);
    }
    const key = cleanKey(connection);
    let url;
    if (connection.channel === 'official')
        url = new URL(`${GEMINI_ORIGIN}/v1beta/models`);
    else {
        url = customUrl(connection);
        const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:interactions|models\/[^/]+:generateContent)$/, '').replace(/\/v1beta$/, '');
        url.pathname = `${path}/v1beta/models`;
    }
    url.searchParams.set('pageSize', '1000');
    const headers = { 'x-goog-api-key': key, Accept: 'application/json' };
    if (connection.channel === 'custom')
        headers.Authorization = `Bearer ${key}`;
    return withRequest(signal, 20_000, async (requestSignal) => {
        const response = await fetch(url.href, { headers, signal: requestSignal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
        const payload = await readJson(response, 8 * 1024 * 1024, requestSignal);
        const list = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : null;
        if (!list || list.length > 10_000)
            fail('模型列表格式无效或超过 10,000 项，请手动填写模型。');
        const names = list.map(item => { const entry = object(item); return String(entry.name ?? entry.id ?? '').replace(/^models\//, ''); })
            .filter(name => /image|banana|imagen/i.test(name) && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name));
        return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    });
}
