import { isPageId, type PageId } from './pages.js';
import type { PetPlacement, PetSpot } from './pet/api.js';

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
  petLines: boolean;
  petMotion: boolean;
  petScale: number;
  petAway: boolean;
  petPlacement: PetPlacement | null;
  /** 画匣色调：跟随酒馆主题、日间或夜间 */
  paintboxTheme: PaintboxTheme;
}

export type PaintboxTheme = 'auto' | 'day' | 'night';
export const isPaintboxTheme = (value: unknown): value is PaintboxTheme => value === 'auto' || value === 'day' || value === 'night';

export interface TavernContext {
  extensionSettings: Record<string, unknown>;
  saveSettingsDebounced(): void;
}

export function defaultSettings(): Settings {
  return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null,
    imageRetentionDays: 0, autoGenerateImages: false, petLines: true, petMotion: true, petScale: 1, petAway: false, petPlacement: null, paintboxTheme: 'auto' };
}

export function readPetScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0.5, Math.min(1.5, value)) * 100) / 100 : 1;
}

function petSpot(value: unknown): PetSpot | undefined {
  const spot = value as Partial<PetSpot> | null | undefined;
  if (!spot || typeof spot !== 'object' || (spot.place !== 'floor' && spot.place !== 'side')
    || (spot.edge !== 'left' && spot.edge !== 'right') || typeof spot.at !== 'number'
    || !Number.isFinite(spot.at) || spot.at < 0 || spot.at > 1) return undefined;
  return { place: spot.place, edge: spot.edge, at: spot.at };
}

/** Keeps only valid spots; null when none is left. */
export function readPetPlacement(value: unknown): PetPlacement | null {
  if (!value || typeof value !== 'object') return null;
  const placement: PetPlacement = {};
  const wide = petSpot((value as PetPlacement).wide);
  const narrow = petSpot((value as PetPlacement).narrow);
  if (wide) placement.wide = wide;
  if (narrow) placement.narrow = narrow;
  return wide || narrow ? placement : null;
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
  if (typeof saved.petLines === 'boolean') settings.petLines = saved.petLines;
  if (typeof saved.petMotion === 'boolean') settings.petMotion = saved.petMotion;
  settings.petScale = readPetScale(saved.petScale);
  if (typeof saved.petAway === 'boolean') settings.petAway = saved.petAway;
  settings.petPlacement = readPetPlacement(saved.petPlacement);
  if (isPaintboxTheme(saved.paintboxTheme)) settings.paintboxTheme = saved.paintboxTheme;
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
