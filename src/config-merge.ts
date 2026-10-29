import { checkWorldbookLinks, modelAttachments, type ParsedArchive } from './config-archive.js';
import { defaultImageSettings, IMAGE_PROVIDERS, imageProviderName, loadAllImageSettings, saveAllImageSettings, type AllImageSettings, type ImageProvider, type ImageSettings } from './image-settings.js';
import { defaultModelSettings, loadAllModelSettings, modelPresetSettings, modelSharedSettings, saveAllModelSettings, type AllModelSettings, type ModelPresetSettings, type ModelSettings, type ModelSharedSettings } from './model-settings.js';
import { loadAnchors, replaceAnchors, type CharacterAnchor } from './anchor-store.js';
import { loadSharedOutfits, replaceSharedOutfits, type SharedOutfit } from './shared-outfit-store.js';
import { loadWorldbookArchive, replaceWorldbookArchive, type StoredWorldbook } from './worldbook-source.js';
import { defaultSettings, readSettings, saveSettings, type Settings, type TavernContext } from './settings.js';

export type ImportSection = 'api' | 'parameters' | 'artists' | 'presets' | 'anchors' | 'sharedOutfits' | 'worldbooks' | 'preferences';
export type ImportMode = 'skip' | 'overwrite';
export type ImportModes = Partial<Record<ImportSection, ImportMode>>;
export interface LocalConfig {
  image: AllImageSettings;
  model: AllModelSettings;
  preferences: Settings;
  anchors: CharacterAnchor[];
  sharedOutfits: SharedOutfit[];
  worldbooks: StoredWorldbook[];
}
type Store = keyof LocalConfig;
type ArtistFields = Pick<ImageSettings, 'artists' | 'positive' | 'negative' | 'activeArtistId'>;
type PresetFields = Omit<ModelPresetSettings, 'worldbookSource' | 'worldbooks'>;
interface Tally { added: number; replaced: number; skipped: number }

export const importSectionTitles: Record<ImportSection, string> = {
  api: '生图与模型 API', parameters: '生图参数', artists: '画师串', presets: '预设',
  anchors: '标签锚定', sharedOutfits: '通用服装', worldbooks: '世界书', preferences: '使用偏好',
};
const PROFILE_LIMIT = 200;
const PARAMETER_FIELDS = ['parameters', 'openaiParameters', 'geminiParameters', 'grokParameters'] as const;

export function importSections(archive: ParsedArchive): ImportSection[] {
  return archive.kind === 'all' ? ['api', 'parameters', 'artists', 'presets', 'anchors', 'sharedOutfits', 'worldbooks', 'preferences'] : [archive.kind];
}

/** Presets are what a share is for; everything else keeps the importer's own setup unless they opt in. */
export function defaultImportModes(archive: ParsedArchive): ImportModes {
  return Object.fromEntries(importSections(archive).map(section => [section, section === 'presets' ? 'overwrite' : 'skip']));
}

/** Only the stores the archive kind can touch are read, so partial imports never wait on the anchor or book libraries. */
export async function loadLocalConfig(archive: ParsedArchive, context: TavernContext): Promise<LocalConfig> {
  const [anchors, worldbooks] = await Promise.all([
    archive.kind === 'all' ? loadAnchors() : Promise.resolve([]),
    archive.kind === 'all' || archive.kind === 'worldbooks' ? loadWorldbookArchive() : Promise.resolve([]),
  ]);
  return { image: loadAllImageSettings(), model: loadAllModelSettings(), preferences: readSettings(context), anchors, sharedOutfits: loadSharedOutfits(), worldbooks };
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function newId(taken: Set<string>): string {
  let id: string;
  do id = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`; while (taken.has(id));
  return id;
}

function tallyText(tally: Tally, mode: ImportMode): string {
  const parts: string[] = [];
  if (tally.added) parts.push(`新增 ${tally.added}`);
  if (tally.replaced) parts.push(`覆盖同名 ${tally.replaced}`);
  if (tally.skipped) parts.push(`${mode === 'skip' ? '跳过同名' : '保留本地同名'} ${tally.skipped}`);
  return parts.join('，') || '文件中没有条目';
}

/** Ids are random per device, so shared files can only be matched by name. `ids` maps file ids to the ids kept locally. */
function mergeNamed<T extends { id: string; name: string }>(local: T[], incoming: T[], mode: ImportMode, tally: Tally,
  replace: (current: T, next: T) => T | null = (current, next) => ({ ...next, id: current.id })): { items: T[]; ids: Map<string, string> } {
  const items = [...local], ids = new Map<string, string>(), taken = new Set(local.map(item => item.id));
  for (const item of incoming) {
    const index = items.findIndex(current => current.name === item.name);
    if (index === -1) {
      const id = taken.has(item.id) ? newId(taken) : item.id;
      taken.add(id); items.push({ ...item, id }); ids.set(item.id, id); tally.added++;
      continue;
    }
    ids.set(item.id, items[index].id);
    const next = mode === 'overwrite' ? replace(items[index], item) : null;
    if (next) { items[index] = next; tally.replaced++; } else tally.skipped++;
  }
  return { items, ids };
}

function mergeArtists(settings: ImageSettings, incoming: ArtistFields, mode: ImportMode): string | null {
  if (!incoming.artists.length && !incoming.positive.trim() && !incoming.negative.trim()) return null;
  const tally: Tally = { added: 0, replaced: 0, skipped: 0 };
  const fresh = !settings.artists.length && !settings.positive.trim() && !settings.negative.trim();
  const { items, ids } = mergeNamed(settings.artists, incoming.artists, mode, tally);
  if (items.length > PROFILE_LIMIT) throw new Error(`${imageProviderName(settings.provider)} 画师串合并后超过 ${PROFILE_LIMIT} 个，请先清理本地画师串。`);
  settings.artists = items;
  const prompts = mode === 'overwrite' || fresh;
  if (prompts) {
    settings.positive = incoming.positive; settings.negative = incoming.negative;
    settings.activeArtistId = ids.get(incoming.activeArtistId) ?? '';
  }
  return `${imageProviderName(settings.provider)}：${tallyText(tally, mode)}；当前提示词${prompts ? '改用文件内容' : '保留本地'}`;
}

function presetFields(preset: ModelPresetSettings): PresetFields {
  const { head, tail, enabledLayers, presetName, promptOrder } = preset;
  return { head, tail, enabledLayers, presetName, promptOrder };
}

/** Mounts stay with the worldbook section; a preset only carries its own entries and order. */
function mergePreset(model: AllModelSettings, provider: ImageProvider, incoming: PresetFields, mode: ImportMode): string | null {
  const current = model.presets[provider], blank = presetFields(modelPresetSettings(defaultModelSettings(provider)));
  const name = `${imageProviderName(provider)} 预设`;
  if (same(presetFields({ ...current, ...incoming }), blank)) return null;
  if (mode === 'skip' && !same(presetFields(current), blank)) return `${name}：本地已有“${current.presetName || '未命名'}”，保留本地`;
  model.presets[provider] = { ...current, ...structuredClone(presetFields({ ...current, ...incoming })) };
  return `${name}：改用“${incoming.presetName || '未命名'}”`;
}

function mergeWorldbooks(config: LocalConfig, books: StoredWorldbook[], attachments: Record<ImageProvider, ModelSettings['worldbooks']>, mode: ImportMode): string {
  const tally: Tally = { added: 0, replaced: 0, skipped: 0 };
  const merged = [...config.worldbooks], written = new Map<string, StoredWorldbook>();
  for (const book of books) {
    const index = merged.findIndex(current => current.name === book.name);
    if (index === -1) { merged.push(book); tally.added++; }
    else if (mode === 'overwrite') { merged[index] = book; tally.replaced++; }
    else { tally.skipped++; continue; }
    written.set(book.name, book);
  }
  // Skipped books keep local mounts; written books take the file's mounts, or keep local picks that still exist.
  for (const provider of IMAGE_PROVIDERS) {
    const preset = config.model.presets[provider];
    const incoming = new Map(attachments[provider].filter(selected => written.has(selected.name)).map(selected => [selected.name, selected]));
    const kept = preset.worldbooks.flatMap(selected => {
      const book = written.get(selected.name);
      if (!book) return [selected];
      const replacement = incoming.get(selected.name);
      if (replacement) { incoming.delete(selected.name); return [replacement]; }
      const ids = new Set(book.entries.map(entry => entry.id));
      const entries = selected.entries.filter(id => ids.has(id));
      return entries.length ? [{ name: selected.name, entries }] : [];
    });
    preset.worldbooks = structuredClone([...kept, ...incoming.values()]);
  }
  checkWorldbookLinks(modelAttachments(config.model), merged);
  config.worldbooks = merged;
  return `${tallyText(tally, mode)}；挂载随导入的书籍更新`;
}

/** Names and aliases share one namespace, so a file anchor that only collides through an alias is never merged. */
function mergeAnchors(config: LocalConfig, incoming: CharacterAnchor[], mode: ImportMode): string {
  const tally: Tally = { added: 0, replaced: 0, skipped: 0 };
  const items = [...config.anchors], taken = new Set(items.map(item => item.id));
  let blocked = 0;
  for (const anchor of incoming) {
    const terms = new Set([anchor.name, ...anchor.aliases]);
    const owners = items.filter(item => [item.name, ...item.aliases].some(term => terms.has(term)));
    if (!owners.length) {
      const id = taken.has(anchor.id) ? newId(taken) : anchor.id;
      taken.add(id); items.push({ ...anchor, id }); tally.added++;
    } else if (owners.length === 1 && owners[0].name === anchor.name) {
      if (mode === 'skip') { tally.skipped++; continue; }
      items[items.indexOf(owners[0])] = { ...anchor, id: owners[0].id, portrait: anchor.portrait ?? owners[0].portrait };
      tally.replaced++;
    } else blocked++;
  }
  config.anchors = items;
  return `${tallyText(tally, mode)}${blocked ? `；${blocked} 个与本地其他角色的名称或别名冲突，已跳过` : ''}`;
}

/** A keyless file never replaces a local endpoint: pairing a local key with a shared URL would send it elsewhere. */
function mergeApi(config: LocalConfig, data: Extract<ParsedArchive, { kind: 'all' }>['data'], mode: ImportMode): string {
  const parts: string[] = [];
  for (const provider of IMAGE_PROVIDERS) {
    const current = config.image.profiles[provider], incoming = data.image.profiles[provider], blank = defaultImageSettings(provider).connection;
    if (same(incoming.connection, blank) && !incoming.connectionProfiles.length) continue;
    const fresh = same(current.connection, blank) && !current.connectionProfiles.length;
    const tally: Tally = { added: 0, replaced: 0, skipped: 0 };
    const { items, ids } = mergeNamed(current.connectionProfiles, incoming.connectionProfiles, mode, tally,
      (local, next) => next.key ? { ...next, id: local.id } : null);
    if (items.length > PROFILE_LIMIT) throw new Error(`${imageProviderName(provider)} 保存的连接合并后超过 ${PROFILE_LIMIT} 个，请先清理本地连接。`);
    current.connectionProfiles = items;
    const take = fresh || (mode === 'overwrite' && Boolean(incoming.connection.key));
    if (take) {
      current.connection = structuredClone(incoming.connection);
      current.activeConnectionId = ids.get(incoming.activeConnectionId) ?? '';
      current.models = [...incoming.models];
    }
    parts.push(`${imageProviderName(provider)}：${take ? '当前连接改用文件' : '保留本地连接'}${incoming.connectionProfiles.length ? `，保存的连接${tallyText(tally, mode)}` : ''}`);
  }
  // The marker switches belong to the preset section.
  const endpoint = ({ mode, url, key, model, models, maxTokens, temperature, transport }: ModelSharedSettings) => ({ mode, url, key, model, models, maxTokens, temperature, transport });
  const api = config.model.api, next = data.model.api;
  const take = same(endpoint(api), endpoint(modelSharedSettings(defaultModelSettings())))
    || (mode === 'overwrite' && (next.mode === 'tavern' || Boolean(next.key)));
  if (take) Object.assign(api, structuredClone(endpoint(next)));
  parts.push(`共用模型 API：${take ? '改用文件' : '保留本地'}`);
  return parts.join('；');
}

function mergeParameters(config: LocalConfig, image: AllImageSettings, mode: ImportMode): string {
  return joined(IMAGE_PROVIDERS.map(provider => {
    const current = config.image.profiles[provider], incoming = image.profiles[provider], blank = defaultImageSettings(provider);
    if (PARAMETER_FIELDS.every(field => same(incoming[field], blank[field]))) return null;
    const take = mode === 'overwrite' || PARAMETER_FIELDS.every(field => same(current[field], blank[field]));
    if (take) for (const field of PARAMETER_FIELDS) Object.assign(current, { [field]: structuredClone(incoming[field]) });
    return `${imageProviderName(provider)}：${take ? '改用文件' : '保留本地'}`;
  }), '文件中均为默认参数，保留本地');
}

/** Channels the file leaves empty are left out of the preview. */
function joined(parts: (string | null)[], empty: string): string {
  return parts.filter(Boolean).join('；') || empty;
}

/** Pure merge over a snapshot, so the review can preview each choice before anything is written. */
export function mergeArchive(archive: ParsedArchive, local: LocalConfig, modes: ImportModes): { config: LocalConfig; stores: Store[]; details: Map<ImportSection, string> } {
  const config: LocalConfig = { ...local, image: structuredClone(local.image), model: structuredClone(local.model), preferences: structuredClone(local.preferences) };
  const details = new Map<ImportSection, string>(), defaults = defaultImportModes(archive);
  const mode = (section: ImportSection): ImportMode => modes[section] ?? defaults[section] ?? 'skip';
  if (archive.kind === 'artists') {
    const { provider, artists } = archive.data;
    details.set('artists', mergeArtists(config.image.profiles[provider], artists, mode('artists')) ?? '文件中没有画师串');
    return { config, stores: ['image'], details };
  }
  if (archive.kind === 'presets') {
    const { provider, presets } = archive.data;
    const before = config.model.presets[provider];
    details.set('presets', mergePreset(config.model, provider, presets, mode('presets')) ?? '文件中的预设为空，保留本地');
    if (config.model.presets[provider] !== before) Object.assign(config.model.api, { parseImageMarkers: presets.parseImageMarkers, hideImageContext: presets.hideImageContext });
    return { config, stores: ['model'], details };
  }
  if (archive.kind === 'worldbooks') {
    details.set('worldbooks', mergeWorldbooks(config, archive.data.worldbooks, archive.data.attachments, mode('worldbooks')));
    return { config, stores: ['worldbooks', 'model'], details };
  }
  const { data } = archive;
  details.set('api', mergeApi(config, data, mode('api')));
  details.set('parameters', mergeParameters(config, data.image, mode('parameters')));
  details.set('artists', joined(IMAGE_PROVIDERS.map(provider => mergeArtists(config.image.profiles[provider], data.image.profiles[provider], mode('artists'))), '文件中没有画师串'));
  const presetsBefore = { ...config.model.presets };
  details.set('presets', joined(IMAGE_PROVIDERS.map(provider => mergePreset(config.model, provider, data.model.presets[provider], mode('presets'))), '文件中的预设为空，保留本地'));
  if (IMAGE_PROVIDERS.some(provider => config.model.presets[provider] !== presetsBefore[provider])) {
    Object.assign(config.model.api, { parseImageMarkers: data.model.api.parseImageMarkers, hideImageContext: data.model.api.hideImageContext });
  }
  details.set('anchors', mergeAnchors(config, data.anchors, mode('anchors')));
  const outfits: Tally = { added: 0, replaced: 0, skipped: 0 };
  config.sharedOutfits = mergeNamed(config.sharedOutfits, data.sharedOutfits, mode('sharedOutfits'), outfits).items;
  details.set('sharedOutfits', tallyText(outfits, mode('sharedOutfits')));
  details.set('worldbooks', mergeWorldbooks(config, data.worldbooks, modelAttachments(data.model), mode('worldbooks')));
  const takePreferences = mode('preferences') === 'overwrite' || same(config.preferences, defaultSettings());
  if (takePreferences) { config.preferences = structuredClone(data.preferences); config.image.activeProvider = data.image.activeProvider; }
  details.set('preferences', takePreferences ? '改用文件中的偏好与当前生图类型' : '本地已有偏好，保留本地');
  return { config, stores: ['anchors', 'sharedOutfits', 'worldbooks', 'model', 'image', 'preferences'], details };
}

/** Merge against freshly read local data; restore completed stores if a later storage operation fails. */
export async function applyArchive(archive: ParsedArchive, context: TavernContext, modes: ImportModes): Promise<void> {
  const local = await loadLocalConfig(archive, context);
  const { config, stores } = mergeArchive(archive, local, modes);
  const writers: Record<Store, (value: LocalConfig) => void | Promise<void>> = {
    anchors: value => replaceAnchors(value.anchors),
    sharedOutfits: value => replaceSharedOutfits(value.sharedOutfits),
    worldbooks: value => replaceWorldbookArchive(value.worldbooks),
    model: value => saveAllModelSettings(value.model),
    image: value => saveAllImageSettings(value.image),
    preferences: value => saveSettings(context, value.preferences),
  };
  const undo: (() => void | Promise<void>)[] = [];
  try {
    for (const store of stores) {
      undo.push(() => writers[store](local));
      await writers[store](config);
    }
  } catch (error) { await rollback(error, undo); }
}

async function rollback(error: unknown, undo: (() => void | Promise<void>)[]): Promise<never> {
  let failed = false;
  for (const restore of undo.reverse()) {
    try { await restore(); } catch { failed = true; }
  }
  throw new Error(`${error instanceof Error ? error.message : '配置导入失败。'}${failed ? '部分配置未能恢复，请保留导入文件并检查浏览器存储。' : '本次更改已撤回，原配置已恢复。'}`);
}
