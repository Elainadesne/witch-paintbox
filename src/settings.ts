import { isPageId, type PageId } from './pages.js';

export const extensionId = 'tavern-image-plugin';

export interface Position {
  x: number;
  y: number;
}

export interface Settings {
  rememberPage: boolean;
  rememberPosition: boolean;
  lastPage: PageId;
  position: Position | null;
  imageRetentionDays: 0 | 1 | 3 | 7;
  autoGenerateImages: boolean;
  autoGenerateLatestOnly: boolean;
}

export interface TavernContext {
  extensionSettings: Record<string, unknown>;
  saveSettingsDebounced(): void;
}

export function defaultSettings(): Settings {
  return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null,
    imageRetentionDays: 0, autoGenerateImages: false, autoGenerateLatestOnly: true };
}

export function readSettings(context: TavernContext): Settings {
  const settings = defaultSettings();
  const raw = context.extensionSettings[extensionId];
  if (!raw || typeof raw !== 'object') return settings;

  const saved = raw as Partial<Settings>;
  if (typeof saved.rememberPage === 'boolean') settings.rememberPage = saved.rememberPage;
  if (typeof saved.rememberPosition === 'boolean') settings.rememberPosition = saved.rememberPosition;
  if ([0, 1, 3, 7].includes(saved.imageRetentionDays!)) settings.imageRetentionDays = saved.imageRetentionDays!;
  if (typeof saved.autoGenerateImages === 'boolean') settings.autoGenerateImages = saved.autoGenerateImages;
  if (typeof saved.autoGenerateLatestOnly === 'boolean') settings.autoGenerateLatestOnly = saved.autoGenerateLatestOnly;
  if (isPageId(saved.lastPage)) settings.lastPage = saved.lastPage;
  if (saved.position && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y)) {
    settings.position = { x: saved.position.x, y: saved.position.y };
  }
  return settings;
}

export function saveSettings(context: TavernContext, settings: Settings): void {
  context.extensionSettings[extensionId] = structuredClone(settings);
  context.saveSettingsDebounced();
  window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
}

export function currentPreferences(): Settings {
  const host = (globalThis as typeof globalThis & { SillyTavern?: { getContext(): TavernContext } }).SillyTavern;
  return host ? readSettings(host.getContext()) : defaultSettings();
}
