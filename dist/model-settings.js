const storageKey = 'witch-paintbox:model-settings:v1';
export const builtinLayerIds = ['worldbook', 'anchors'];
export function createPromptOrder(head, tail, layers = builtinLayerIds) {
    return [...head.map(entry => `prompt:${entry.id}`), ...layers.map(id => `layer:${id}`), 'input', ...tail.map(entry => `prompt:${entry.id}`)];
}
export function defaultModelSettings() {
    return {
        mode: 'tavern', url: '', key: '', model: '', models: [],
        maxTokens: 2048, temperature: 1, transport: 'compatible',
        head: [], tail: [], enabledLayers: [...builtinLayerIds], presetName: '', parseImageMarkers: true,
        hideImageContext: true, promptOrder: createPromptOrder([], []), worldbooks: [],
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
    if (!Array.isArray(value) || value.length > 200)
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
    if (all.length > 200 || new Set(all.map(entry => entry.id)).size !== all.length)
        invalid();
    const legacyLayers = stringList(source.enabledLayers, 100);
    const enabledLayers = source.promptOrder === undefined ? [...new Set([...legacyLayers, ...builtinLayerIds])] : legacyLayers;
    const promptOrder = source.promptOrder === undefined
        ? createPromptOrder(head, tail, enabledLayers)
        : stringList(source.promptOrder, 301);
    const promptKeys = new Set(all.map(entry => `prompt:${entry.id}`));
    if (promptOrder.filter(key => key === 'input').length !== 1
        || [...promptKeys].some(key => !promptOrder.includes(key))
        || enabledLayers.some(id => !promptOrder.includes(`layer:${id}`))
        || promptOrder.some(key => key !== 'input' && !promptKeys.has(key) && !/^layer:[a-z0-9][a-z0-9._-]{0,127}$/i.test(key)))
        invalid();
    const books = source.worldbooks === undefined ? [] : source.worldbooks;
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
    return {
        mode: source.mode, url: text(source.url, 8192), key: text(source.key, 16_384),
        model: text(source.model, 512), models: stringList(source.models, 10_000),
        maxTokens: number(source.maxTokens, 1, 65_536, true), temperature: number(source.temperature, 0, 2),
        transport: source.transport, head, tail,
        enabledLayers, promptOrder, worldbooks,
        presetName: source.presetName === undefined ? '' : text(source.presetName, 256),
        parseImageMarkers: source.parseImageMarkers === undefined ? true : source.parseImageMarkers,
        hideImageContext: source.hideImageContext === undefined ? true : source.hideImageContext,
    };
}
function stored() {
    try {
        const storage = window.localStorage;
        return { storage, raw: storage.getItem(storageKey) };
    }
    catch {
        throw new Error('浏览器无法读取模型配置，请检查站点存储权限。');
    }
}
function parse(raw) {
    try {
        return validateModelSettings(JSON.parse(raw));
    }
    catch {
        throw new Error('已保存的模型配置无法读取，原始记录已保留，未覆盖。');
    }
}
export function loadModelSettings() {
    const { raw } = stored();
    return raw === null ? defaultModelSettings() : parse(raw);
}
export function hasSavedModelSettings() { return stored().raw !== null; }
export function saveModelSettings(settings) {
    const value = validateModelSettings(settings);
    const { storage, raw: previous } = stored();
    if (previous !== null)
        parse(previous);
    const raw = JSON.stringify(value);
    try {
        storage.setItem(storageKey, raw);
        if (storage.getItem(storageKey) !== raw)
            throw new Error();
    }
    catch {
        throw new Error('模型配置未能保存，请检查浏览器存储权限或剩余空间。');
    }
    window.dispatchEvent(new Event('witch-paintbox:model-settings-changed'));
}
