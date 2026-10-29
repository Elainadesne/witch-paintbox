import { isPageId } from './pages.js';
export const extensionId = 'tavern-image-plugin';
export const DEFAULT_EXCLUDED_TAGS = ['think', 'thinking', 'UpdateVariable'];
export const MAX_EXCLUDED_TAGS = 24;
/** 标签名：允许写成 <tag>，去掉尖括号与斜杠；只收合法的 XML 名称。 */
export function normalizeTagName(value) {
    const name = value.trim().replace(/^<\/?|\/?>$/g, '').trim();
    return /^[A-Za-z_][\w:.-]{0,39}$/.test(name) ? name : null;
}
export function readExcludedTags(value) {
    if (!Array.isArray(value))
        return null;
    const seen = new Set();
    const tags = [];
    for (const item of value) {
        const name = typeof item === 'string' ? normalizeTagName(item) : null;
        if (!name || seen.has(name.toLowerCase()))
            continue;
        seen.add(name.toLowerCase());
        tags.push(name);
        if (tags.length >= MAX_EXCLUDED_TAGS)
            break;
    }
    return tags;
}
export const isPaintboxTheme = (value) => value === 'auto' || value === 'day' || value === 'night';
export function defaultSettings() {
    return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null,
        imageRetentionDays: 0, autoGenerateImages: false, petLines: true, petMotion: true, petScale: 1, petAway: false, petPlacement: null, paintboxTheme: 'auto', excludedTags: [...DEFAULT_EXCLUDED_TAGS] };
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
    if (isPaintboxTheme(saved.paintboxTheme))
        settings.paintboxTheme = saved.paintboxTheme;
    settings.excludedTags = readExcludedTags(saved.excludedTags) ?? settings.excludedTags;
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
/** 在指定插图窗里改排除标签：直接写回酒馆扩展设置，再广播偏好变化让主面板同步。 */
export function saveExcludedTags(tags) {
    const host = globalThis.SillyTavern;
    const next = readExcludedTags([...tags]) ?? [];
    if (!host)
        return next;
    const context = host.getContext();
    const settings = readSettings(context);
    settings.excludedTags = next;
    saveSettings(context, settings);
    return next;
}
export function currentPreferences() {
    const host = globalThis.SillyTavern;
    return host ? readSettings(host.getContext()) : defaultSettings();
}
