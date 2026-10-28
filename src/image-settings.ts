import { createSettingsStorage } from './host-settings.js';
import { defaultOpenAIImageParameters, validateOpenAIImageParameters, type OpenAIImageParameters } from './openai-image.js';
import { withFault } from './pet-events.js';

export type ImageProvider = 'novelai' | 'openai';
export const IMAGE_PROVIDERS: readonly ImageProvider[] = ['novelai', 'openai'];
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
  provider: ImageProvider;
  openaiParameters: OpenAIImageParameters;
  models: string[];
  connection: ImageConnection;
  connectionProfiles: ConnectionProfile[];
  activeConnectionId: string;
  parameters: ImageParameters;
  positive: string;
  negative: string;
  artists: ArtistPreset[];
  activeArtistId: string;
}

export interface AllImageSettings {
  version: 2;
  activeProvider: ImageProvider;
  profiles: Record<ImageProvider, ImageSettings>;
}

const storageKey = 'witch-paintbox:image-settings:v1';

export function defaultImageSettings(provider: ImageProvider = 'novelai'): ImageSettings {
  return {
    provider, openaiParameters: defaultOpenAIImageParameters(), models: [],
    connection: { channel: 'official', url: '', key: '', appendSuffix: true },
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
  throw withFault(new Error('生图配置格式无效，请检查参数和配置条目。'), 'setup');
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

function connection(value: unknown, provider: ImageProvider): ImageConnection {
  const source = record(value);
  if (source.channel !== 'official' && source.channel !== 'custom') invalid();
  const url = text(source.url, 8192);
  let appendSuffix = source.appendSuffix === undefined ? true : boolean(source.appendSuffix);
  // Older NAI connections only expanded a bare origin; keep custom paths intact.
  if (source.appendSuffix === undefined && provider === 'novelai' && source.channel === 'custom' && url.trim()) {
    try { appendSuffix = new URL(url.trim()).pathname === '/'; }
    catch { appendSuffix = false; }
  }
  return { channel: source.channel, url, key: text(source.key, 16_384), appendSuffix };
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
  const provider = source.provider ?? 'novelai';
  if (provider !== 'novelai' && provider !== 'openai') invalid();
  const models = source.models ?? [];
  if (!Array.isArray(models) || models.length > 10_000) invalid();
  const modelNames = models.map(value => text(value, 512, true));
  if (new Set(modelNames).size !== modelNames.length) invalid();
  const connectionProfiles = profiles(source.connectionProfiles, value => {
    const item = record(value);
    return { ...connection(item, provider), id: text(item.id, 128, true), name: text(item.name, 128, true) };
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
  if (provider === 'openai' && (text(source.negative).trim() || artists.some(item => item.negative.trim()))) {
    throw new Error('GPT 配置不支持独立负面提示词，请先在来源配置中移除负面字段内容，再导入 GPT 配置。');
  }
  return {
    provider, models: modelNames,
    openaiParameters: validateOpenAIImageParameters(source.openaiParameters ?? defaultOpenAIImageParameters()),
    connection: connection(source.connection, provider),
    connectionProfiles,
    activeConnectionId: selectedId(source.activeConnectionId, connectionProfiles),
    parameters: parameters(source.parameters),
    positive: text(source.positive),
    negative: text(source.negative),
    artists,
    activeArtistId: selectedId(source.activeArtistId, artists),
  };
}

function sameConnection(left: ImageConnection, right: ImageConnection): boolean {
  return left.channel === right.channel && left.url === right.url && left.appendSuffix === right.appendSuffix;
}

export function defaultAllImageSettings(): AllImageSettings {
  return { version: 2, activeProvider: 'novelai', profiles: {
    novelai: defaultImageSettings('novelai'), openai: defaultImageSettings('openai'),
  } };
}

export function validateAllImageSettings(value: unknown): AllImageSettings {
  const source = record(value);
  if (source.version === undefined) {
    const legacy = validateImageSettings(source);
    const all = defaultAllImageSettings();
    all.profiles[legacy.provider] = legacy;
    all.activeProvider = legacy.provider;
    return all;
  }
  if (source.version !== 2 || !IMAGE_PROVIDERS.includes(source.activeProvider as ImageProvider)) invalid();
  const profiles = record(source.profiles);
  const novelai = validateImageSettings(profiles.novelai);
  const openai = validateImageSettings(profiles.openai);
  if (novelai.provider !== 'novelai' || openai.provider !== 'openai') invalid();
  return { version: 2, activeProvider: source.activeProvider as ImageProvider, profiles: { novelai, openai } };
}

const settingsStorage = createSettingsStorage<AllImageSettings>({
  localKey: storageKey, hostKey: 'image-settings-v1', label: '生图配置',
  defaults: defaultAllImageSettings, validate: validateAllImageSettings,
  stripKeys(value) {
    for (const settings of Object.values(value.profiles)) {
      settings.connection.key = '';
      settings.connectionProfiles.forEach(profile => { profile.key = ''; });
    }
    return value;
  },
  restoreKeys(value, local) {
    for (const provider of IMAGE_PROVIDERS) {
      const settings = value.profiles[provider], savedSettings = local.profiles[provider];
      const active = savedSettings.connectionProfiles.find(item => item.id === settings.activeConnectionId && sameConnection(item, settings.connection));
      settings.connection.key = active?.key ?? (settings.activeConnectionId === savedSettings.activeConnectionId
        && sameConnection(settings.connection, savedSettings.connection) ? savedSettings.connection.key : '');
      for (const profile of settings.connectionProfiles) {
        const saved = savedSettings.connectionProfiles.find(item => item.id === profile.id && sameConnection(item, profile));
        profile.key = saved?.key ?? '';
      }
    }
    return value;
  },
  changed() { window.dispatchEvent(new Event('witch-paintbox:image-settings-changed')); },
});

export function loadAllImageSettings(): AllImageSettings { return settingsStorage.load(); }
export function loadImageSettings(provider?: ImageProvider): ImageSettings {
  const all = settingsStorage.load();
  return all.profiles[provider ?? all.activeProvider];
}
export function saveImageSettings(settings: ImageSettings): Promise<void> {
  const snapshot = validateImageSettings(settings);
  return settingsStorage.update(all => ({ ...all, profiles: { ...all.profiles, [snapshot.provider]: snapshot } }));
}
export async function switchImageProvider(provider: ImageProvider): Promise<void> {
  if (!IMAGE_PROVIDERS.includes(provider)) invalid();
  if (settingsStorage.load().activeProvider === provider) return;
  await settingsStorage.update(all => ({ ...all, activeProvider: provider }));
  window.dispatchEvent(new Event('witch-paintbox:image-provider-changed'));
}
/** Bulk import refreshes the UI only after every section commits or rolls back. */
export function saveAllImageSettings(settings: AllImageSettings): Promise<void> {
  return settingsStorage.save(settings);
}
