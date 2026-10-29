/** Gemini and Grok draw by aspect ratio and resolution tier instead of exact pixels. */
export const GEMINI_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'];
export const GROK_ASPECT_RATIOS = [
    'auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2',
];
export const GEMINI_IMAGE_SIZES = ['1K', '2K', '4K'];
export const GROK_RESOLUTIONS = ['1k', '2k'];
export const GROK_QUALITIES = ['auto', 'low', 'medium'];
export const GEMINI_PROTOCOLS = ['interactions', 'generateContent', 'openai'];
export const GROK_PROTOCOLS = ['xai', 'openai'];
/** Official Gemini image models (ai.google.dev, image-generation). */
export const GEMINI_MODELS = [
    'gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image',
];
export const GROK_DEFAULT_MODEL = 'grok-imagine-image-2.0';
/** Older Gemini image models only draw at their single default tier. */
export function geminiFixedTier(model) {
    const name = model.trim().replace(/^models\//, '');
    if (/^gemini-2\.5-flash-image(?:-|$)/.test(name))
        return 'omit';
    if (/^gemini-3\.1-flash-lite-image(?:-|$)/.test(name))
        return '1K';
    return null;
}
const GEMINI_FROM_SIZE = {
    '832x1216': '2:3', '1216x832': '3:2', '1024x1024': '1:1', '768x1344': '9:16', '1344x768': '16:9', '896x1152': '4:5', '1152x896': '5:4',
};
const GROK_FROM_SIZE = {
    '832x1216': '2:3', '1216x832': '3:2', '1024x1024': '1:1', '768x1344': '9:16', '1344x768': '16:9', '896x1152': '3:4', '1152x896': '4:3',
};
export function geminiRatioForSize(size) { return GEMINI_FROM_SIZE[size]; }
export function grokRatioForSize(size) { return GROK_FROM_SIZE[size]; }
/** Gemini's documented 1K grid (Nano Banana 2.1 / 3.x); 2K and 4K double it. */
const GEMINI_1K = {
    '1:1': [1024, 1024], '2:3': [848, 1264], '3:2': [1264, 848], '3:4': [896, 1200], '4:3': [1200, 896],
    '4:5': [928, 1152], '5:4': [1152, 928], '9:16': [768, 1376], '16:9': [1376, 768],
};
const GEMINI_25 = {
    '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832], '3:4': [864, 1184], '4:3': [1184, 864],
    '4:5': [896, 1152], '5:4': [1152, 896], '9:16': [768, 1344], '16:9': [1344, 768],
};
/** Expected output size, used for frame placeholders and the settings hint. */
export function geminiExpectedSize(model, ratio, size) {
    const tier = geminiFixedTier(model);
    const [width, height] = (tier === 'omit' ? GEMINI_25 : GEMINI_1K)[ratio];
    const scale = tier ? 1 : size === '4K' ? 4 : size === '2K' ? 2 : 1;
    return { width: width * scale, height: height * scale };
}
export function ratioDimensions(ratio, longEdge) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
    if (!match)
        return { width: longEdge, height: longEdge };
    const w = Number(match[1]), h = Number(match[2]);
    return w >= h
        ? { width: longEdge, height: Math.max(1, Math.round(longEdge * h / w)) }
        : { width: Math.max(1, Math.round(longEdge * w / h)), height: longEdge };
}
/** Grok does not publish pixels; this is only an estimate for placeholders. */
export function grokExpectedSize(ratio, resolution) {
    return ratioDimensions(ratio === 'auto' ? '1:1' : ratio, resolution === '2k' ? 2048 : 1024);
}
/** The OpenAI-compatible relay route still needs a `size`; keep it a 16-multiple near 1K. */
export function ratioToOpenAISize(ratio) {
    const { width, height } = ratioDimensions(ratio === 'auto' ? '1:1' : ratio, 1536);
    const round = (value) => Math.max(256, Math.round(value / 16) * 16);
    return `${round(width)}x${round(height)}`;
}
export function defaultGeminiImageParameters() {
    return { protocol: 'interactions', model: GEMINI_MODELS[0], aspectRatio: '2:3', imageSize: '1K' };
}
export function defaultGrokImageParameters() {
    return { protocol: 'xai', model: GROK_DEFAULT_MODEL, aspectRatio: '2:3', resolution: '1k', quality: 'auto' };
}
function modelName(value) {
    return typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}
function pick(value, items) {
    return typeof value === 'string' && items.includes(value) ? value : null;
}
export function validateGeminiImageParameters(value, fail) {
    const source = (value ?? {});
    const model = modelName(source.model);
    const protocol = pick(source.protocol, GEMINI_PROTOCOLS);
    const aspectRatio = pick(source.aspectRatio, GEMINI_ASPECT_RATIOS);
    const imageSize = pick(source.imageSize, GEMINI_IMAGE_SIZES);
    if (model === null || !protocol || !aspectRatio || !imageSize)
        fail();
    return { protocol, model, aspectRatio, imageSize };
}
export function validateGrokImageParameters(value, fail) {
    const source = (value ?? {});
    const model = modelName(source.model);
    const protocol = pick(source.protocol, GROK_PROTOCOLS);
    const aspectRatio = pick(source.aspectRatio, GROK_ASPECT_RATIOS);
    const resolution = pick(source.resolution, GROK_RESOLUTIONS);
    const quality = pick(source.quality, GROK_QUALITIES);
    if (model === null || !protocol || !aspectRatio || !resolution || !quality)
        fail();
    return { protocol, model, aspectRatio, resolution, quality };
}
