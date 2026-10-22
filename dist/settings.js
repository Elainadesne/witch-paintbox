import { isPageId } from './pages.js';
export const extensionId = 'tavern-image-plugin';
export function defaultSettings() {
    return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null };
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
}
