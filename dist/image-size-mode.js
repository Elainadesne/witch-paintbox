export const SIZE_PROTOCOL_NAMES = {
    fixed: '📐 格式｜默认画幅·三字段输出协议',
    ai: '📐 格式｜AI动态画幅·四字段输出协议',
};
export function imageSizeEntryMode(entry) {
    if (entry.marker)
        return null;
    if (entry.name === SIZE_PROTOCOL_NAMES.fixed)
        return 'fixed';
    if (entry.name === SIZE_PROTOCOL_NAMES.ai)
        return 'ai';
    return null;
}
export function imageSizeMode(settings) {
    const enabled = [...settings.head, ...settings.tail].filter(entry => entry.enabled);
    return enabled.some(entry => imageSizeEntryMode(entry) === 'ai')
        && !enabled.some(entry => imageSizeEntryMode(entry) === 'fixed') ? 'ai' : 'fixed';
}
/** Change only the two named protocol groups; other draft fields remain untouched. */
export function applyImageSizeMode(settings, mode) {
    const update = (entries) => entries.map(entry => {
        const entryMode = imageSizeEntryMode(entry);
        return entryMode ? { ...entry, enabled: entryMode === mode } : entry;
    });
    return { ...settings, head: update(settings.head), tail: update(settings.tail) };
}
export function selectImageSizeMode(settings, mode) {
    if (![...settings.head, ...settings.tail].some(entry => imageSizeEntryMode(entry) === mode)) {
        throw new Error(`请先在当前生图接口的模型 API 预设中导入并保存“${SIZE_PROTOCOL_NAMES[mode]}”条目。`);
    }
    return applyImageSizeMode(settings, mode);
}
/** Old presets and deliberately disabled protocols remain valid; conflicts prefer fixed size. */
export function normalizeSizeProtocolEntries(settings) {
    if (![...settings.head, ...settings.tail].some(entry => entry.enabled && imageSizeEntryMode(entry) === 'fixed'))
        return settings;
    const update = (entries) => entries.map(entry => entry.enabled && imageSizeEntryMode(entry) === 'ai' ? { ...entry, enabled: false } : entry);
    return { ...settings, head: update(settings.head), tail: update(settings.tail) };
}
