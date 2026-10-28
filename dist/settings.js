import { isPageId } from './pages.js';
export const extensionId = 'tavern-image-plugin';
export function defaultSettings() {
    return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null,
        imageRetentionDays: 0, autoGenerateImages: false, petLines: true, petMotion: true, petScale: 1, petAway: false, petPlacement: null };
}
export function readPetScale(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(0.5, Math.min(1.5, value)) * 100) / 100 : 1;
}
function petSpot(value) {
    const spot = value;
    if (!spot || typeof spot !== 'object' || (spot.place !== 'floor' && spot.place !== 'side')
        || (spot.edge !== 'left' && spot.edge !== 'right') || typeof spot.at !== 'number'
        || !Number.isFinite(spot.at) || spot.at < 0 || spot.at > 1)
        return undefined;
    return { place: spot.place, edge: spot.edge, at: spot.at };
}
/** Keeps only valid spots; null when none is left. */
export function readPetPlacement(value) {
    if (!value || typeof value !== 'object')
        return null;
    const placement = {};
    const wide = petSpot(value.wide);
    const narrow = petSpot(value.narrow);
    if (wide)
        placement.wide = wide;
    if (narrow)
        placement.narrow = narrow;
    return wide || narrow ? placement : null;
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
    if (typeof saved.petLines === 'boolean')
        settings.petLines = saved.petLines;
    if (typeof saved.petMotion === 'boolean')
        settings.petMotion = saved.petMotion;
    settings.petScale = readPetScale(saved.petScale);
    if (typeof saved.petAway === 'boolean')
        settings.petAway = saved.petAway;
    settings.petPlacement = readPetPlacement(saved.petPlacement);
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
