import { defaultImageSettings, loadImageSettings, validateImageSettings, loadAllImageSettings, validateAllImageSettings, IMAGE_PROVIDERS, imageProviderName } from './image-settings.js';
import { defaultModelSettings, loadModelSettings, validateModelSettings, loadAllModelSettings, validateAllModelSettings } from './model-settings.js';
import { loadAnchors, validateAnchorLibrary, ANCHOR_PORTRAIT_LIMIT } from './anchor-store.js';
import { loadSharedOutfits, validateSharedOutfits } from './shared-outfit-store.js';
import { loadWorldbookArchive, validateWorldbookArchive } from './worldbook-source.js';
import { defaultSettings, readPetPlacement, readPetScale, readSettings, isPaintboxTheme, readAutoImageDelay, readExcludedTags } from './settings.js';
import { isPageId } from './pages.js';
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label}格式无效。`);
    return value;
}
function fields(value, names, label) {
    if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
        throw new Error(`${label}字段缺失或含有不支持的配置，请使用完整的魔女画匣导出文件。`);
    }
}
function preferences(value) {
    const source = object(value, '使用偏好');
    if (typeof source.rememberPage !== 'boolean' || typeof source.rememberPosition !== 'boolean' || !isPageId(source.lastPage)) {
        throw new Error('使用偏好格式无效。');
    }
    let position = null;
    if (source.position !== null) {
        const point = object(source.position, '悬浮球位置');
        if (typeof point.x !== 'number' || !Number.isFinite(point.x) || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
            throw new Error('悬浮球位置格式无效。');
        }
        position = { x: point.x, y: point.y };
    }
    const optional = defaultSettings();
    if (source.imageRetentionDays !== undefined) {
        if (![0, 1, 3, 7].includes(source.imageRetentionDays))
            throw new Error('图片保留时间格式无效。');
        optional.imageRetentionDays = source.imageRetentionDays;
    }
    if (source.autoProcessReplies !== undefined) {
        if (typeof source.autoProcessReplies !== 'boolean')
            throw new Error('自动 AI 生图偏好格式无效。');
        optional.autoProcessReplies = source.autoProcessReplies;
    }
    if (source.autoGenerateImages !== undefined) {
        if (typeof source.autoGenerateImages !== 'boolean')
            throw new Error('自动点击生图偏好格式无效。');
        optional.autoGenerateImages = source.autoGenerateImages;
    }
    if (source.autoImageDelay !== undefined) {
        const delay = readAutoImageDelay(source.autoImageDelay);
        if (delay === null)
            throw new Error('自动点击生图间隔须在 0～60 秒之间。');
        optional.autoImageDelay = delay;
    }
    for (const name of ['petLines', 'petMotion', 'petAway']) {
        const value = source[name];
        if (value === undefined)
            continue;
        if (typeof value !== 'boolean')
            throw new Error('使用偏好格式无效。');
        optional[name] = value;
    }
    if (source.excludedTags !== undefined) {
        const tags = readExcludedTags(source.excludedTags);
        if (!tags)
            throw new Error('排除标签格式无效。');
        optional.excludedTags = tags;
    }
    if (source.paintboxTheme !== undefined) {
        if (!isPaintboxTheme(source.paintboxTheme))
            throw new Error('画匣色调格式无效。');
        optional.paintboxTheme = source.paintboxTheme;
    }
    if (source.petPlacement !== undefined)
        optional.petPlacement = readPetPlacement(source.petPlacement);
    if (source.petScale !== undefined) {
        if (typeof source.petScale !== 'number' || !Number.isFinite(source.petScale) || source.petScale < 0.5 || source.petScale > 1.5) {
            throw new Error('缇娅的大小须在 50%～150% 之间。');
        }
        optional.petScale = readPetScale(source.petScale);
    }
    return { ...optional, rememberPage: source.rememberPage, rememberPosition: source.rememberPosition, lastPage: source.lastPage, position };
}
const providerName = (provider) => imageProviderName(provider);
function imageProvider(value) {
    if (!IMAGE_PROVIDERS.includes(value))
        throw new Error('配置文件的生图类型无效。');
    return value;
}
function artistSettings(value, provider) {
    const source = object(value, '画师串');
    fields(source, ['artists', 'positive', 'negative', 'activeArtistId'], '画师串');
    const validated = validateImageSettings({ ...defaultImageSettings(provider), ...source });
    return { artists: validated.artists, positive: validated.positive, negative: validated.negative, activeArtistId: validated.activeArtistId };
}
function selectPreset(settings) {
    const { presetName, head, tail, promptOrder, enabledLayers, parseImageMarkers, hideImageContext } = settings;
    return { presetName, head, tail, promptOrder, enabledLayers, parseImageMarkers, hideImageContext };
}
function presetSettings(value, provider) {
    const source = object(value, '预设');
    fields(source, ['presetName', 'head', 'tail', 'promptOrder', 'enabledLayers', 'parseImageMarkers', 'hideImageContext'], '预设');
    return selectPreset(validateModelSettings({ ...defaultModelSettings(provider), ...source }));
}
export function modelAttachments(model) {
    return Object.fromEntries(IMAGE_PROVIDERS.map(provider => [provider, model.presets[provider].worldbooks]));
}
function worldbookSettings(value, version) {
    const source = object(value, '世界书配置');
    fields(source, ['worldbooks', 'attachments'], '世界书配置');
    const worldbooks = validateWorldbookArchive(source.worldbooks);
    let raw;
    if (version === 1) {
        if (!Array.isArray(source.attachments))
            throw new Error('旧版世界书挂载必须是数组。');
        raw = { novelai: source.attachments, openai: [] };
    }
    else {
        raw = object(source.attachments, '世界书挂载');
        fields(raw, [...IMAGE_PROVIDERS], '世界书挂载');
    }
    // Files from before Gemini / Grok carry only two mount sets; the new channels start empty.
    const attachments = Object.fromEntries(IMAGE_PROVIDERS.map(provider => [provider,
        validateModelSettings({ ...defaultModelSettings(provider), worldbooks: raw[provider] ?? [] }).worldbooks]));
    checkWorldbookLinks(attachments, worldbooks);
    return { worldbooks, attachments };
}
async function encodePortrait(blob) {
    if (!blob)
        return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32_768)
        binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
    const encoded = `data:${blob.type};base64,${btoa(binary)}`;
    decodePortrait(encoded);
    return encoded;
}
function decodePortrait(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || value.length > Math.ceil(ANCHOR_PORTRAIT_LIMIT / 3) * 4 + 64) {
        throw new Error('角色图格式无效或超过 10 MiB。');
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match)
        throw new Error('角色图必须是内嵌的 PNG、JPEG 或 WebP。');
    let binary;
    try {
        binary = atob(match[2]);
    }
    catch {
        throw new Error('角色图编码损坏。');
    }
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const valid = match[1] === 'image/png'
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
        : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP';
    if (!valid)
        throw new Error('角色图内容与图片类型不符。');
    return new Blob([bytes], { type: match[1] });
}
function anchors(value) {
    if (!Array.isArray(value) || value.length > 10_000)
        throw new Error('角色锚定列表无效。');
    return validateAnchorLibrary(value.map(raw => {
        const item = object(raw, '角色锚定');
        return { ...item, portrait: decodePortrait(item.portrait) };
    }));
}
export function checkWorldbookLinks(attachments, books) {
    const available = new Map(books.map(book => [book.name, new Set(book.entries.map(entry => entry.id))]));
    for (const provider of IMAGE_PROVIDERS) {
        for (const selected of attachments[provider]) {
            const entries = available.get(selected.name);
            if (!entries || selected.entries.some(id => !entries.has(id))) {
                throw new Error(`${providerName(provider)} 世界书挂载“${selected.name}”缺少对应书籍或条目，无法完整迁移。`);
            }
        }
    }
}
function archiveConnections(archive) {
    if (archive.kind !== 'all')
        return [];
    const { image, model } = archive.data;
    return [...IMAGE_PROVIDERS.flatMap(provider => {
            const settings = image.profiles[provider];
            return [settings.connection, ...settings.connectionProfiles];
        }), model.api];
}
export function archiveKeyCount(archive) {
    return archiveConnections(archive).filter(connection => Boolean(connection.key)).length;
}
export function archiveUrlCount(archive) {
    return archiveConnections(archive).filter(connection => connection.url.trim()).length;
}
export function parseArchive(source) {
    if (source.length > MAX_ARCHIVE_BYTES || new TextEncoder().encode(source).byteLength > MAX_ARCHIVE_BYTES)
        throw new Error('配置文件不能超过 128 MiB。');
    let decoded;
    try {
        decoded = JSON.parse(source.replace(/^\uFEFF/, ''));
    }
    catch {
        throw new Error('文件不是有效的 JSON。');
    }
    const raw = object(decoded, '配置文件');
    fields(raw, ['format', 'version', 'kind', 'exportedAt', 'includesKeys', 'data'], '配置文件');
    if (raw.format !== 'witch-paintbox-config')
        throw new Error('请选择魔女画匣导出的配置文件；原始模型预设和世界书 JSON 请在各自页面导入。');
    if (raw.version !== 1 && raw.version !== 2)
        throw new Error('不支持这个配置文件版本，请更新插件后重试。');
    if (!['all', 'artists', 'presets', 'worldbooks'].includes(String(raw.kind)) || typeof raw.includesKeys !== 'boolean'
        || typeof raw.exportedAt !== 'string' || raw.exportedAt.length > 64 || !Number.isFinite(Date.parse(raw.exportedAt))) {
        throw new Error('配置文件的类型、时间或密钥标记无效。');
    }
    const base = { format: 'witch-paintbox-config', version: raw.version, kind: raw.kind,
        exportedAt: raw.exportedAt, includesKeys: raw.includesKeys };
    const data = object(raw.data, '配置内容');
    let result;
    if (raw.kind !== 'all' && raw.includesKeys)
        throw new Error('局部配置文件不应包含密钥。');
    if (raw.kind === 'artists') {
        fields(data, raw.version === 1 ? ['artists'] : ['provider', 'artists'], '画师串分享文件');
        const provider = raw.version === 1 ? 'novelai' : imageProvider(data.provider);
        result = { ...base, kind: 'artists', data: { provider, artists: artistSettings(data.artists, provider) } };
    }
    else if (raw.kind === 'presets') {
        fields(data, raw.version === 1 ? ['presets'] : ['provider', 'presets'], '预设分享文件');
        const provider = raw.version === 1 ? 'novelai' : imageProvider(data.provider);
        result = { ...base, kind: 'presets', data: { provider, presets: presetSettings(data.presets, provider) } };
    }
    else if (raw.kind === 'worldbooks') {
        result = { ...base, kind: 'worldbooks', data: worldbookSettings(data, raw.version) };
    }
    else {
        const required = ['image', 'model', 'preferences', 'anchors', 'worldbooks'];
        fields(data, Object.hasOwn(data, 'sharedOutfits') ? [...required, 'sharedOutfits'] : required, '完整配置');
        let image, model;
        if (raw.version === 1) {
            const modelRaw = object(data.model, '模型配置');
            if (modelRaw.worldbookSource !== 'uploads')
                throw new Error('配置文件的世界书来源不受支持。');
            image = validateAllImageSettings(validateImageSettings({ ...object(data.image, '生图配置'), provider: 'novelai' }));
            model = validateAllModelSettings(validateModelSettings({ ...modelRaw, presetProvider: 'novelai' }));
        }
        else {
            const modelRaw = object(data.model, '模型配置');
            if (object(data.image, '生图配置').version !== 2 || modelRaw.version !== 2) {
                throw new Error('新版完整配置必须包含各生图通道的配置。');
            }
            const presets = object(modelRaw.presets, '模型预设');
            for (const provider of IMAGE_PROVIDERS) {
                // Gemini / Grok presets are absent in files exported before those channels existed.
                if (presets[provider] === undefined && (provider === 'gemini' || provider === 'grok'))
                    continue;
                if (object(presets[provider], `${providerName(provider)} 预设`).worldbookSource !== 'uploads') {
                    throw new Error(`${providerName(provider)} 预设的世界书来源不受支持。`);
                }
            }
            image = validateAllImageSettings(data.image);
            model = validateAllModelSettings(data.model);
        }
        const worldbooks = validateWorldbookArchive(data.worldbooks);
        checkWorldbookLinks(modelAttachments(model), worldbooks);
        const sharedOutfits = validateSharedOutfits(Object.hasOwn(data, 'sharedOutfits') ? data.sharedOutfits : []);
        result = { ...base, kind: 'all', data: { image, model, worldbooks, anchors: anchors(data.anchors), sharedOutfits, preferences: preferences(data.preferences) } };
    }
    if (!result.includesKeys && archiveKeyCount(result))
        throw new Error('文件标记为不含密钥，但实际包含密钥，已停止导入。');
    return result;
}
export async function exportArchive(kind, includeKeys, context) {
    const envelope = { format: 'witch-paintbox-config', version: 2, kind, exportedAt: new Date().toISOString(), includesKeys: kind === 'all' && includeKeys };
    let data;
    if (kind === 'artists') {
        const image = loadImageSettings();
        data = { provider: image.provider, artists: artistSettings({ artists: image.artists, positive: image.positive, negative: image.negative, activeArtistId: image.activeArtistId }, image.provider) };
    }
    else if (kind === 'presets') {
        const model = loadModelSettings();
        data = { provider: model.presetProvider, presets: selectPreset(model) };
    }
    else if (kind === 'worldbooks') {
        const attachments = modelAttachments(loadAllModelSettings());
        const worldbooks = await loadWorldbookArchive();
        checkWorldbookLinks(attachments, worldbooks);
        data = { worldbooks, attachments };
    }
    else {
        const image = loadAllImageSettings(), model = loadAllModelSettings();
        const [characters, worldbooks] = await Promise.all([loadAnchors(), loadWorldbookArchive()]);
        checkWorldbookLinks(modelAttachments(model), worldbooks);
        if (!includeKeys) {
            for (const provider of IMAGE_PROVIDERS) {
                const settings = image.profiles[provider];
                for (const connection of [settings.connection, ...settings.connectionProfiles]) {
                    connection.key = '';
                    connection.url = '';
                }
            }
            model.api.key = '';
            model.api.url = '';
        }
        const portable = [];
        for (const character of characters)
            portable.push({ ...character, portrait: await encodePortrait(character.portrait) });
        data = { image, model, preferences: readSettings(context), anchors: portable, sharedOutfits: loadSharedOutfits(), worldbooks };
    }
    const blob = new Blob([JSON.stringify({ ...envelope, data }, null, 2)], { type: 'application/json' });
    if (blob.size > MAX_ARCHIVE_BYTES)
        throw new Error('配置文件超过 128 MiB，请先减少角色图或世界书体积。');
    return blob;
}
export function summarizeArchive(archive) {
    const rows = [];
    if (archive.version === 1)
        rows.push({ title: '旧版配置兼容', detail: archive.kind === 'all'
                ? '旧版单套配置归入 NAI；文件中其他通道为空，不会改动本地对应配置。'
                : archive.kind === 'worldbooks' ? '旧版世界书挂载归入 NAI。'
                    : '旧版分享文件的目标为 NAI，不会替换 GPT 的画师串或预设。' });
    if (archive.kind === 'artists') {
        const artists = archive.data.artists;
        rows.push({ title: `${providerName(archive.data.provider)} 画师串`, detail: `${artists.artists.length} 个命名配置及当前提示词、选用状态。${artists.artists.map(item => item.name).join('、')}` });
        return rows;
    }
    if (archive.kind === 'presets') {
        const preset = archive.data.presets;
        rows.push({ title: `${providerName(archive.data.provider)} 预设`, detail: `“${preset.presetName || '未命名'}”，${preset.head.length + preset.tail.length} 个文本条目，含条目编排、功能层启用状态；配图标记开关为各通道共用设置。` });
        return rows;
    }
    if (archive.kind === 'worldbooks') {
        const { worldbooks, attachments } = archive.data;
        rows.push({ title: '世界书', detail: `${worldbooks.length} 本、${worldbooks.reduce((total, book) => total + book.entries.length, 0)} 个条目。${worldbooks.map(book => book.name).join('、')}` });
        for (const provider of IMAGE_PROVIDERS)
            rows.push({ title: `${providerName(provider)} 条目挂载`, detail: `${attachments[provider].reduce((total, book) => total + book.entries.length, 0)} 个条目，来自 ${attachments[provider].filter(book => book.entries.length).length} 本书；该套世界书层的启用状态和预设位置保留当前设置。` });
        return rows;
    }
    const { image, model, anchors, sharedOutfits, worldbooks } = archive.data;
    rows.push({ title: '当前生图类型', detail: providerName(image.activeProvider) });
    for (const provider of IMAGE_PROVIDERS) {
        const settings = image.profiles[provider], preset = model.presets[provider];
        const canvas = provider === 'novelai' ? `${settings.parameters.width} × ${settings.parameters.height}`
            : provider === 'openai' ? `${settings.openaiParameters.width} × ${settings.openaiParameters.height}`
                : provider === 'gemini' ? `${settings.geminiParameters.aspectRatio} · ${settings.geminiParameters.imageSize}`
                    : `${settings.grokParameters.aspectRatio} · ${settings.grokParameters.resolution.toUpperCase()}`;
        const modelLabel = provider === 'novelai' ? settings.parameters.model : provider === 'openai' ? settings.openaiParameters.model
            : provider === 'gemini' ? settings.geminiParameters.model : settings.grokParameters.model;
        rows.push({ title: `${providerName(provider)} 生图 API`, detail: `${settings.connectionProfiles.length} 个保存连接；模型 ${modelLabel || '未选模型'}，${canvas}，含全部生图参数。` }, { title: `${providerName(provider)} 画师串`, detail: `${settings.artists.length} 个命名配置及当前提示词。${settings.artists.map(item => item.name).join('、')}` }, { title: `${providerName(provider)} 预设`, detail: `“${preset.presetName || '未命名'}”，${preset.head.length + preset.tail.length} 个文本条目，含编排、功能层选择和 ${preset.worldbooks.length} 本世界书挂载。` });
    }
    rows.push({ title: '共用模型 API', detail: `${model.api.mode === 'tavern' ? '跟随酒馆主 API' : `自定义接口 · ${model.api.model || '未选模型'}`}；含回复参数及配图标记开关。` }, { title: '标签锚定', detail: `${anchors.length} 个角色、${anchors.reduce((total, anchor) => total + anchor.aliases.length, 0)} 个别名、${anchors.reduce((total, anchor) => total + anchor.outfits.length, 0)} 套服装、${anchors.filter(anchor => anchor.portrait).length} 张角色图。` }, { title: '通用服装库', detail: `${sharedOutfits.length} 套通用服装。${sharedOutfits.map(outfit => outfit.name).join('、')}` }, { title: '世界书', detail: `${worldbooks.length} 本、${worldbooks.reduce((total, book) => total + book.entries.length, 0)} 个条目，含各通道挂载关系。${worldbooks.map(book => book.name).join('、')}` }, { title: '使用偏好', detail: `含页面记忆与悬浮球位置。自动 AI 生图：${archive.data.preferences.autoProcessReplies ? '开启' : '关闭'}；自动点击生图：${archive.data.preferences.autoGenerateImages ? '开启' : '关闭'}（仅限最新一楼，间隔 ${archive.data.preferences.autoImageDelay} 秒）；自动清理：${archive.data.preferences.imageRetentionDays ? `保留 ${archive.data.preferences.imageRetentionDays} 天，采用文件偏好后会清理本机过期图片` : '关闭'}。` });
    return rows;
}
