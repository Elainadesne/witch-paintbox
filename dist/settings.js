import { isPageId } from './pages.js';
export const extensionId = 'tavern-image-plugin';
export function defaultSettings() {
    return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null,
        imageRetentionDays: 0, autoGenerateImages: false, autoGenerateLatestOnly: true };
}
export function readSettings(context) {
    const settings = defaultSettings();
    const raw = context.extensionSettings[extensionId];
    if (!raw || typeof raw !== 'object')
        return settings;
    const saved = raw;
    if (typeof saved.rememberPage === 'boolean')
        settings.rememberPage = saved.rememberPage;
    if (typeof saved.rememberPosition === 'boolean')
        settings.rememberPosition = saved.rememberPosition;
    if ([0, 1, 3, 7].includes(saved.imageRetentionDays))
        settings.imageRetentionDays = saved.imageRetentionDays;
    if (typeof saved.autoGenerateImages === 'boolean')
        settings.autoGenerateImages = saved.autoGenerateImages;
    if (typeof saved.autoGenerateLatestOnly === 'boolean')
        settings.autoGenerateLatestOnly = saved.autoGenerateLatestOnly;
    if (isPageId(saved.lastPage))
        settings.lastPage = saved.lastPage;
    if (saved.position && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y)) {
        settings.position = { x: saved.position.x, y: saved.position.y };
    }
    return settings;
}
export function saveSettings(context, settings) {
    context.extensionSettings[extensionId] = structuredClone(settings);
    context.saveSettingsDebounced();
    window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
}
export function currentPreferences() {
    const host = globalThis.SillyTavern;
    return host ? readSettings(host.getContext()) : defaultSettings();
}
