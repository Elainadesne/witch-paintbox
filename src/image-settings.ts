import {
  defaultImageParameters,
  NAI_MODELS,
  NAI_SAMPLERS,
  NAI_SCHEDULES,
  type ImageConnection,
  type ImageParameters,
} from './novelai.js';

export interface ConnectionProfile extends ImageConnection {
  id: string;
  name: string;
}

export interface ArtistPreset {
  id: string;
  name: string;
  positive: string;
  negative: string;
}

export interface ImageSettings {
  connection: ImageConnection;
  connectionProfiles: ConnectionProfile[];
  activeConnectionId: string;
  parameters: ImageParameters;
  positive: string;
  negative: string;
  artists: ArtistPreset[];
  activeArtistId: string;
}

const storageKey = 'witch-paintbox:image-settings:v1';

export function defaultImageSettings(): ImageSettings {
  return {
    connection: { channel: 'official', url: '', key: '' },
    connectionProfiles: [],
    activeConnectionId: '',
    parameters: defaultImageParameters(),
    positive: '',
    negative: '',
    artists: [],
    activeArtistId: '',
  };
}

function invalid(): never {
  throw new Error('生图配置格式无效，请检查参数和配置条目。');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength = 65_536, required = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim())) invalid();
  return value;
}

function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  if (integer && !Number.isInteger(value)) invalid();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function option(value: unknown, options: readonly { value: string }[]): string {
  const selected = text(value, 128, true);
  if (!options.some(item => item.value === selected)) invalid();
  return selected;
}

function connection(value: unknown): ImageConnection {
  const source = record(value);
  if (source.channel !== 'official' && source.channel !== 'custom') invalid();
  return { channel: source.channel, url: text(source.url, 8192), key: text(source.key, 16_384) };
}

function parameters(value: unknown): ImageParameters {
  const source = record(value);
  const width = number(source.width, 64, 4096, true);
  const height = number(source.height, 64, 4096, true);
  if (width % 64 || height % 64) invalid();
  return {
    model: option(source.model, NAI_MODELS),
    width,
    height,
    steps: number(source.steps, 1, 50, true),
    scale: number(source.scale, 0, 100),
    sampler: option(source.sampler, NAI_SAMPLERS),
    seed: number(source.seed, -1, 4_294_967_295, true),
    noiseSchedule: option(source.noiseSchedule, NAI_SCHEDULES),
    cfgRescale: number(source.cfgRescale, 0, 1),
    sm: boolean(source.sm),
    smDyn: boolean(source.smDyn),
  };
}

function profiles<T extends { id: string }>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 200) invalid();
  const items = value.map(parse);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return items;
}

function selectedId(value: unknown, items: { id: string }[]): string {
  const id = text(value, 128);
  if (id && !items.some(item => item.id === id)) invalid();
  return id;
}

export function validateImageSettings(value: unknown): ImageSettings {
  const source = record(value);
  const connectionProfiles = profiles(source.connectionProfiles, value => {
    const item = record(value);
    return { ...connection(item), id: text(item.id, 128, true), name: text(item.name, 128, true) };
  });
  const artists = profiles(source.artists, value => {
    const item = record(value);
    return {
      id: text(item.id, 128, true),
      name: text(item.name, 128, true),
      positive: text(item.positive),
      negative: text(item.negative),
    };
  });
  return {
    connection: connection(source.connection),
    connectionProfiles,
    activeConnectionId: selectedId(source.activeConnectionId, connectionProfiles),
    parameters: parameters(source.parameters),
    positive: text(source.positive),
    negative: text(source.negative),
    artists,
    activeArtistId: selectedId(source.activeArtistId, artists),
  };
}

function parseSaved(raw: string): ImageSettings {
  try {
    return validateImageSettings(JSON.parse(raw));
  } catch {
    throw new Error('已保存的生图配置无法读取，原始记录已保留，未覆盖。');
  }
}

function readStored(): { storage: Storage; raw: string | null } {
  try {
    const storage = window.localStorage;
    return { storage, raw: storage.getItem(storageKey) };
  } catch {
    throw new Error('浏览器无法读取生图配置，请检查站点存储权限。');
  }
}

export function loadImageSettings(): ImageSettings {
  const { raw } = readStored();
  return raw === null ? defaultImageSettings() : parseSaved(raw);
}

export function saveImageSettings(settings: ImageSettings): void {
  const value = validateImageSettings(settings);
  const { storage, raw: previous } = readStored();
  // Preserve an unreadable record instead of replacing it with a fresh UI state.
  if (previous !== null) parseSaved(previous);
  const raw = JSON.stringify(value);
  try {
    storage.setItem(storageKey, raw);
    if (storage.getItem(storageKey) !== raw) throw new Error();
  } catch {
    throw new Error('浏览器未能保存生图配置，请检查存储权限或剩余空间后重试。');
  }
}
