import { createSettingsStorage } from './host-settings.js';
import { loadImageSettings } from './image-settings.js';
import { applyImageSizeMode, normalizeSizeProtocolEntries, sameSizeProtocolEntries, selectImageSizeMode } from './image-size-mode.js';
export const MAX_PRESET_ENTRIES = 10_000;
const storageKey = 'witch-paintbox:model-settings:v1';
export const builtinLayerIds = ['worldbook', 'anchors'];
export function createPromptOrder(head, tail, layers = builtinLayerIds) {
    return [...head.map(entry => `prompt:${entry.id}`), ...layers.map(id => `layer:${id}`), 'input', ...tail.map(entry => `prompt:${entry.id}`)];
}
export function defaultModelSettings(presetProvider = 'novelai') {
    return {
        presetProvider, mode: 'tavern', url: '', key: '', model: '', models: [],
        maxTokens: 2048, temperature: 1, transport: 'compatible',
        head: [], tail: [], enabledLayers: [...builtinLayerIds], presetName: '', parseImageMarkers: true,
        hideImageContext: true, promptOrder: createPromptOrder([], []), worldbookSource: 'uploads', worldbooks: [],
    };
}
function invalid() { throw new Error('模型配置格式无效，请检查填写内容。'); }
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    return value;
}
function text(value, max) {
    if (typeof value !== 'string' || value.length > max)
        invalid();
    return value;
}
function number(value, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
        || (integer && !Number.isInteger(value)))
        invalid();
    return value;
}
function stringList(value, max) {
    if (!Array.isArray(value) || value.length > max)
        invalid();
    const items = value.map(item => text(item, 512));
    if (items.some(item => !item.trim()) || new Set(items).size !== items.length)
        invalid();
    return items;
}
function entries(value) {
    if (!Array.isArray(value) || value.length > MAX_PRESET_ENTRIES)
        invalid();
    const items = value.map(raw => {
        const entry = record(raw);
        if (!['system', 'user', 'assistant'].includes(String(entry.role)) || typeof entry.enabled !== 'boolean')
            invalid();
        const id = text(entry.id, 128);
        if (!id.trim())
            invalid();
        if (entry.marker !== undefined && typeof entry.marker !== 'boolean')
            invalid();
        if (entry.marker && entry.enabled)
            invalid();
        return {
            id, name: entry.name === undefined ? id : text(entry.name, 256),
            role: entry.role, content: text(entry.content, 65_536), enabled: entry.enabled,
            ...(entry.marker ? { marker: true } : {}),
        };
    });
    if (new Set(items.map(item => item.id)).size !== items.length)
        invalid();
    return items;
}
export function validateModelSettings(value) {
    const source = record(value);
    if (source.presetProvider !== undefined && source.presetProvider !== 'novelai' && source.presetProvider !== 'openai')
        invalid();
    if (source.mode !== 'tavern' && source.mode !== 'custom')
        invalid();
    if (source.transport !== 'nonstream' && source.transport !== 'stream' && source.transport !== 'compatible')
        invalid();
    if (source.parseImageMarkers !== undefined && typeof source.parseImageMarkers !== 'boolean')
        invalid();
    if (source.hideImageContext !== undefined && typeof source.hideImageContext !== 'boolean')
        invalid();
    const head = entries(source.head);
    const tail = entries(source.tail);
    const all = [...head, ...tail];
    if (all.length > MAX_PRESET_ENTRIES || new Set(all.map(entry => entry.id)).size !== all.length)
        invalid();
    const legacyLayers = stringList(source.enabledLayers, 100);
    const enabledLayers = source.promptOrder === undefined ? [...new Set([...legacyLayers, ...builtinLayerIds])] : legacyLayers;
    const promptOrder = source.promptOrder === undefined
        ? createPromptOrder(head, tail, enabledLayers)
        : stringList(source.promptOrder, MAX_PRESET_ENTRIES + 101);
    const promptKeys = new Set(all.map(entry => `prompt:${entry.id}`));
    const orderKeys = new Set(promptOrder);
    if (promptOrder.filter(key => key === 'input').length !== 1
        || [...promptKeys].some(key => !orderKeys.has(key))
        || enabledLayers.some(id => !orderKeys.has(`layer:${id}`))
        || promptOrder.some(key => key !== 'input' && !promptKeys.has(key) && !/^layer:[a-z0-9][a-z0-9._-]{0,127}$/i.test(key)))
        invalid();
    if (source.worldbookSource !== undefined && source.worldbookSource !== 'uploads')
        invalid();
    // Native Tavern selections from the previous version must never match an uploaded book by accident.
    const books = source.worldbookSource === 'uploads' ? source.worldbooks ?? [] : [];
    if (!Array.isArray(books) || books.length > 100)
        invalid();
    const worldbooks = books.map(raw => {
        const book = record(raw);
        const name = text(book.name, 512);
        if (!name.trim())
            invalid();
        return { name, entries: stringList(book.entries, 10_000) };
    });
    if (new Set(worldbooks.map(book => book.name)).size !== worldbooks.length)
        invalid();
    return normalizeSizeProtocolEntries({
        presetProvider: source.presetProvider === 'openai' ? 'openai' : 'novelai',
        mode: source.mode, url: text(source.url, 8192), key: text(source.key, 16_384),
        model: text(source.model, 512), models: stringList(source.models, 10_000),
        maxTokens: number(source.maxTokens, 1, 65_536, true), temperature: number(source.temperature, 0, 2),
        transport: source.transport, head, tail,
        enabledLayers, promptOrder, worldbookSource: 'uploads', worldbooks,
        presetName: source.presetName === undefined ? '' : text(source.presetName, 256),
        parseImageMarkers: source.parseImageMarkers === undefined ? true : source.parseImageMarkers,
        hideImageContext: source.hideImageContext === undefined ? true : source.hideImageContext,
    });
}
export function modelPresetSettings(settings) {
    const { head, tail, enabledLayers, presetName, promptOrder, worldbookSource, worldbooks } = settings;
    return structuredClone({ head, tail, enabledLayers, presetName, promptOrder, worldbookSource, worldbooks });
}
export function modelSharedSettings(settings) {
    const { mode, url, key, model, models, maxTokens, temperature, transport, parseImageMarkers, hideImageContext } = settings;
    return structuredClone({ mode, url, key, model, models, maxTokens, temperature, transport, parseImageMarkers, hideImageContext });
}
function defaultAllModelSettings() {
    return {
        version: 2,
        api: modelSharedSettings(defaultModelSettings()),
        presets: { novelai: modelPresetSettings(defaultModelSettings('novelai')), openai: modelPresetSettings(defaultModelSettings('openai')) },
    };
}
export function validateAllModelSettings(value) {
    const source = record(value);
    if (source.version === undefined) {
        // Every pre-provider record belongs to the original NovelAI preset.
        const legacy = validateModelSettings(source);
        return { ...defaultAllModelSettings(), api: modelSharedSettings(legacy), presets: {
                novelai: modelPresetSettings(legacy), openai: modelPresetSettings(defaultModelSettings('openai')),
            } };
    }
    if (source.version !== 2)
        invalid();
    const api = record(source.api), presets = record(source.presets);
    const novelai = validateModelSettings({ ...record(presets.novelai), ...api, presetProvider: 'novelai' });
    const openai = validateModelSettings({ ...record(presets.openai), ...api, presetProvider: 'openai' });
    return { version: 2, api: modelSharedSettings(novelai), presets: {
            novelai: modelPresetSettings(novelai), openai: modelPresetSettings(openai),
        } };
}
const settingsStorage = createSettingsStorage({
    localKey: storageKey, hostKey: 'model-settings-v1', label: '模型配置',
    defaults: defaultAllModelSettings, validate: validateAllModelSettings,
    stripKeys(value) { value.api.key = ''; return value; },
    restoreKeys(value, local) {
        value.api.key = value.api.mode === local.api.mode && value.api.url === local.api.url ? local.api.key : '';
        return value;
    },
    changed() { window.dispatchEvent(new Event('witch-paintbox:model-settings-changed')); },
});
export function loadAllModelSettings() { return settingsStorage.load(); }
export function saveAllModelSettings(value) { return settingsStorage.save(validateAllModelSettings(value)); }
export function loadModelSettings(provider = loadImageSettings().provider) {
    const value = loadAllModelSettings();
    return validateModelSettings({ ...value.api, ...value.presets[provider], presetProvider: provider });
}
export function hasSavedModelSettings() { return settingsStorage.hasSaved(); }
/** A deleted book must disappear from both provider presets. */
export async function detachStoredWorldbook(name) {
    if (!hasSavedModelSettings())
        return;
    await settingsStorage.update(settings => {
        for (const provider of ['novelai', 'openai']) {
            settings.presets[provider].worldbooks = settings.presets[provider].worldbooks.filter(book => book.name !== name);
        }
        return settings;
    });
}
export function saveModelSettings(settings) {
    const value = validateModelSettings(settings);
    return settingsStorage.update(current => ({
        version: 2,
        api: modelSharedSettings(value),
        presets: { ...current.presets, [value.presetProvider]: modelPresetSettings(value) },
    }));
}
let pendingImageSizeModeSaves = 0;
export function isImageSizeModeSaving() { return pendingImageSizeModeSaves > 0; }
/** Persist only protocol enablement, so changing image size mode never saves unrelated drafts. */
export async function saveImageSizeMode(provider, mode, expected) {
    const snapshot = expected ? structuredClone(expected) : undefined;
    pendingImageSizeModeSaves++;
    window.dispatchEvent(new Event('witch-paintbox:image-size-mode-saving'));
    try {
        await settingsStorage.update(current => {
            const preset = current.presets[provider];
            if (snapshot && !sameSizeProtocolEntries(preset, snapshot)) {
                throw new Error('画幅协议有未保存或已变更的内容，请先保存预设配置。');
            }
            return {
                ...current,
                presets: { ...current.presets, [provider]: mode === null ? applyImageSizeMode(preset, null) : selectImageSizeMode(preset, mode) },
            };
        });
        window.dispatchEvent(new CustomEvent('witch-paintbox:image-size-mode-changed', { detail: { provider, mode } }));
    }
    finally {
        pendingImageSizeModeSaves--;
        window.dispatchEvent(new Event('witch-paintbox:image-size-mode-saving'));
    }
}
