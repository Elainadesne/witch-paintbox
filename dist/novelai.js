import { ImageResponseError, readImageResponse, requireImageSupport } from './image-response.js';
import { queueImageGeneration } from './image-queue.js';
// Official model catalog: https://docs.novelai.net/en/image/models/
export const NAI_MODELS = [
    { value: 'nai-diffusion-5-full', label: 'NAI Diffusion V5 Full' },
    { value: 'nai-diffusion-5-curated', label: 'NAI Diffusion V5 Curated' },
    { value: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full' },
    { value: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated' },
    { value: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full' },
    { value: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion V4 Curated' },
    { value: 'nai-diffusion-3', label: 'NAI Diffusion V3' },
];
export const NAI_SAMPLERS = [
    { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
    { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { value: 'k_dpm_fast', label: 'DPM Fast' },
];
export const NAI_SCHEDULES = [
    { value: 'karras', label: 'Karras' },
    { value: 'exponential', label: 'Exponential' },
    { value: 'polyexponential', label: 'Polyexponential' },
    { value: 'native', label: 'Native · V3' },
];
export const NAI_SIZE_PRESETS = [
    { value: '832x1216', label: '竖图（832×1216）', width: 832, height: 1216 },
    { value: '1216x832', label: '横图（1216×832）', width: 1216, height: 832 },
    { value: '1024x1024', label: '方图（1024×1024）', width: 1024, height: 1024 },
    { value: '768x1344', label: '768×1344（高竖图）', width: 768, height: 1344 },
    { value: '1344x768', label: '1344×768（宽横图）', width: 1344, height: 768 },
    { value: '896x1152', label: '896×1152', width: 896, height: 1152 },
    { value: '1152x896', label: '1152×896', width: 1152, height: 896 },
];
const OFFICIAL_ENDPOINT = 'https://image.novelai.net/ai/generate-image';
const GENERATION_TIMEOUT_MS = 300_000;
export function defaultImageParameters() {
    return {
        model: 'nai-diffusion-5-full', width: 832, height: 1216,
        steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: -1,
        noiseSchedule: 'karras', cfgRescale: 0, sm: false, smDyn: false,
    };
}
function fail(message, fault) {
    throw new ImageResponseError(message, fault);
}
export function validateImageConnection(connection) {
    if (!connection || !['official', 'custom'].includes(connection.channel))
        fail('请选择官方或自定义渠道。', 'setup');
    const key = typeof connection.key === 'string' ? connection.key.trim().replace(/^Bearer\s+/i, '') : '';
    if (!key || /[^\x21-\x7e]/.test(key))
        fail('请填写有效的 API 密钥。', 'setup');
    const url = typeof connection.url === 'string' ? connection.url.trim() : '';
    if (connection.channel === 'official')
        return { channel: 'official', url, key };
    let endpoint;
    try {
        endpoint = new URL(url);
    }
    catch {
        return fail('请输入完整的自定义 URL，包含 https:// 或 http://。', 'setup');
    }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
        fail('自定义 URL 仅支持 HTTP 或 HTTPS，且不能包含账号、密码或 # 片段。', 'setup');
    }
    if (endpoint.pathname === '/')
        endpoint.pathname = '/ai/generate-image';
    return { channel: 'custom', url: endpoint.href, key };
}
function validateParameters(params) {
    const within = (value, min, max, integer = false) => Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
    if (!NAI_MODELS.some(item => item.value === params.model))
        fail('请选择支持的 NAI 模型。', 'setup');
    if (![params.width, params.height].every(value => within(value, 64, 4096, true) && value % 64 === 0)) {
        fail('宽度和高度须为 64 至 4096 之间的 64 倍数。', 'setup');
    }
    if (!within(params.steps, 1, 50, true))
        fail('采样步数须为 1 至 50 的整数。', 'setup');
    if (!within(params.scale, 0, 100))
        fail('提示词引导须在 0 至 100 之间。', 'setup');
    if (!within(params.seed, -1, 4294967295, true))
        fail('种子须为 -1 至 4294967295 的整数。', 'setup');
    if (!within(params.cfgRescale, 0, 1))
        fail('引导重缩放须在 0 至 1 之间。', 'setup');
    if (!NAI_SAMPLERS.some(item => item.value === params.sampler))
        fail('请选择支持的采样器。', 'setup');
    if (!NAI_SCHEDULES.some(item => item.value === params.noiseSchedule))
        fail('请选择支持的噪声调度。', 'setup');
    if (typeof params.sm !== 'boolean' || typeof params.smDyn !== 'boolean')
        fail('SMEA 设置无效。', 'setup');
    if (params.model !== 'nai-diffusion-3' && (params.sm || params.smDyn))
        fail('SMEA 和 SMEA DYN 仅适用于 V3。', 'setup');
    if (params.smDyn && !params.sm)
        fail('请先启用 SMEA，再启用 SMEA DYN。', 'setup');
    if (params.sampler !== 'k_dpm_fast') {
        if (params.model.startsWith('nai-diffusion-5') && params.noiseSchedule !== 'karras') {
            fail('V5 使用 Karras 噪声调度。', 'setup');
        }
        if (params.model.startsWith('nai-diffusion-4') && params.noiseSchedule === 'native') {
            fail('V4 和 V4.5 不支持 Native 噪声调度。', 'setup');
        }
    }
}
function abortError() {
    const error = new ImageResponseError('本次生图已取消。');
    error.name = 'AbortError';
    return error;
}
function snapshotCharacters(characters, model) {
    if (!Array.isArray(characters))
        fail('角色分栏格式无效，请使用角色提示词列表。', 'setup');
    if (characters.length && model === 'nai-diffusion-3')
        fail('NAI V3 不支持角色分栏，请选择 V4、V4.5 或 V5。', 'setup');
    const limit = model.startsWith('nai-diffusion-5') ? 22 : 6;
    if (characters.length > limit)
        fail(`当前模型最多支持 ${limit} 个角色分栏。`, 'setup');
    return Array.from(characters, (character, index) => {
        if (!character || typeof character !== 'object' || Array.isArray(character)
            || typeof character.positive !== 'string' || !character.positive.trim()
            || typeof character.negative !== 'string') {
            fail(`第 ${index + 1} 个角色分栏无效：正面提示词不能为空，负面提示词须为文本。`, 'setup');
        }
        return { positive: character.positive, negative: character.negative };
    });
}
/** Freeze each click before joining the shared queue; never repeat a billable request. */
export async function generateImage(connection, params, positive, negative, signal, onProgress, characters = []) {
    if (signal.aborted)
        throw abortError();
    const configured = validateImageConnection(connection);
    params = { ...params };
    validateParameters(params);
    if (typeof positive !== 'string' || !positive.trim() || typeof negative !== 'string') {
        fail('请填写正面提示词。', 'setup');
    }
    const characterSnapshot = snapshotCharacters(characters, params.model);
    requireImageSupport();
    const seed = params.seed === -1 ? crypto.getRandomValues(new Uint32Array(1))[0] : params.seed;
    const isV5 = params.model.startsWith('nai-diffusion-5');
    // Request schema: https://image.novelai.net/docs/doc.json
    // Keep the user's prompts intact; quality tags and negative presets are not inserted.
    const parameters = {
        params_version: isV5 ? 4 : 3,
        width: params.width, height: params.height, steps: params.steps,
        scale: params.scale, sampler: params.sampler, seed, n_samples: 1,
        negative_prompt: negative, qualityToggle: false, image_format: 'png',
        cfg_rescale: params.cfgRescale, dynamic_thresholding: false,
        skip_cfg_above_sigma: null, legacy: false, legacy_v3_extend: false,
        add_original_image: false, uncond_scale: 1, prefer_brownian: true,
        deliberate_euler_ancestral_bug: false,
        ...(isV5 ? { noise_schedule: 'karras', straight_alpha: true }
            : params.sampler !== 'k_dpm_fast' ? { noise_schedule: params.noiseSchedule } : {}),
        ...(params.model === 'nai-diffusion-3' ? { sm: params.sm, sm_dyn: params.smDyn } : {}),
    };
    if (isV5 || params.model.startsWith('nai-diffusion-4')) {
        parameters.v4_prompt = {
            caption: {
                base_caption: positive,
                char_captions: characterSnapshot.map(character => ({
                    char_caption: character.positive, centers: [{ x: 0.5, y: 0.5 }],
                })),
            },
            use_coords: false, use_order: true,
        };
        parameters.v4_negative_prompt = {
            caption: {
                base_caption: negative,
                char_captions: characterSnapshot.map(character => ({
                    char_caption: character.negative, centers: [{ x: 0.5, y: 0.5 }],
                })),
            },
            legacy_uc: false,
        };
        parameters.use_coords = false;
        parameters.characterPrompts = characterSnapshot.map(character => ({
            prompt: character.positive, uc: character.negative, center: { x: 0.5, y: 0.5 },
        }));
        parameters.reference_image_multiple = [];
        parameters.reference_information_extracted_multiple = [];
        parameters.reference_strength_multiple = [];
    }
    const body = JSON.stringify({ input: positive, model: params.model, action: 'generate', parameters });
    return queueImageGeneration(() => requestImage(configured, body, seed, signal), signal, onProgress);
}
async function requestImage(configured, body, seed, signal) {
    const controller = new AbortController();
    let interruption;
    const interrupt = (error) => {
        interruption ??= error;
        controller.abort();
    };
    const cancel = () => interrupt(abortError());
    const ensureActive = () => {
        if (interruption)
            throw interruption;
        if (signal.aborted)
            throw abortError();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted)
        cancel();
    const timer = setTimeout(() => interrupt(new ImageResponseError('生图等待超时，请确认服务端任务状态后再操作；没有自动重试。', 'timeout')), GENERATION_TIMEOUT_MS);
    try {
        ensureActive();
        const response = await fetch(configured.channel === 'official' ? OFFICIAL_ENDPOINT : configured.url, {
            method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
            headers: { Authorization: `Bearer ${configured.key}`, 'Content-Type': 'application/json', Accept: 'application/zip' },
            body,
            signal: controller.signal,
        });
        ensureActive();
        if (!response.ok) {
            void response.body?.cancel().catch(() => { });
            if (response.status === 401 || response.status === 403)
                fail('密钥无效、已过期或没有生图权限。', 'auth');
            if (response.status === 402)
                fail('生图额度或订阅不足，请检查账号。', 'quota');
            if (response.status === 429)
                fail('当前请求过多，请稍后手动重试。', 'busy');
            fail(`生图失败（HTTP ${response.status}），请检查渠道和参数；没有自动重试。`, 'unknown');
        }
        const blob = await readImageResponse(response, controller.signal, ensureActive);
        ensureActive();
        return { blob, seed };
    }
    catch (error) {
        if (interruption)
            throw interruption;
        if (error instanceof ImageResponseError)
            throw error;
        return fail('生图未完成，请检查网络或浏览器跨域限制；没有自动重试。', 'network');
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        controller.abort();
    }
}
