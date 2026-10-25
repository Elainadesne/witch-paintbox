import { defaultImageSettings, loadImageSettings, saveImageSettings, validateImageSettings, loadAllImageSettings, saveAllImageSettings, validateAllImageSettings, IMAGE_PROVIDERS, type AllImageSettings, type ImageProvider, type ImageSettings } from './image-settings.js';
import { defaultModelSettings, loadModelSettings, saveModelSettings, validateModelSettings, loadAllModelSettings, saveAllModelSettings, validateAllModelSettings, type AllModelSettings, type ModelSettings } from './model-settings.js';
import { loadAnchors, replaceAnchors, validateAnchorLibrary, ANCHOR_PORTRAIT_LIMIT, type CharacterAnchor } from './anchor-store.js';
import { loadSharedOutfits, replaceSharedOutfits, validateSharedOutfits, type SharedOutfit } from './shared-outfit-store.js';
import { loadWorldbookArchive, replaceWorldbookArchive, validateWorldbookArchive, type StoredWorldbook } from './worldbook-source.js';
import { readSettings, saveSettings, type Settings, type TavernContext } from './settings.js';
import { isPageId } from './pages.js';

export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export type ArchiveKind = 'all' | 'artists' | 'presets' | 'worldbooks';
type ArtistSettings = Pick<ImageSettings, 'artists' | 'positive' | 'negative' | 'activeArtistId'>;
type PresetSettings = Pick<ModelSettings, 'presetName' | 'head' | 'tail' | 'promptOrder' | 'enabledLayers' | 'parseImageMarkers' | 'hideImageContext'>;
type WorldbookAttachments = Record<ImageProvider, ModelSettings['worldbooks']>;
interface WorldbookSettings { worldbooks: StoredWorldbook[]; attachments: WorldbookAttachments }
type PortableAnchor = Omit<CharacterAnchor, 'portrait'> & { portrait: string | null };
interface CompleteSettings {
  image: AllImageSettings;
  model: AllModelSettings;
  preferences: Settings;
  anchors: CharacterAnchor[];
  sharedOutfits: SharedOutfit[];
  worldbooks: StoredWorldbook[];
}
interface Envelope {
  format: 'witch-paintbox-config';
  version: 1 | 2;
  kind: ArchiveKind;
  exportedAt: string;
  includesKeys: boolean;
}
export type ParsedArchive = Envelope & (
  { kind: 'all'; data: CompleteSettings }
  | { kind: 'artists'; data: { provider: ImageProvider; artists: ArtistSettings } }
  | { kind: 'presets'; data: { provider: ImageProvider; presets: PresetSettings } }
  | { kind: 'worldbooks'; data: WorldbookSettings }
);
export interface ArchiveSummary { title: string; detail: string }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, names: string[], label: string): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error(`${label}字段缺失或含有不支持的配置，请使用完整的魔女画匣导出文件。`);
  }
}

function preferences(value: unknown): Settings {
  const source = object(value, '使用偏好');
  if (typeof source.rememberPage !== 'boolean' || typeof source.rememberPosition !== 'boolean' || !isPageId(source.lastPage)) {
    throw new Error('使用偏好格式无效。');
  }
  let position = null;
  if (source.position !== null) {
    const point = object(source.position, '悬浮球位置');
    if (typeof point.x !== 'number' || !Number.isFinite(point.x) || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
      throw new Error('悬浮球位置格式无效。');
    }
    position = { x: point.x, y: point.y };
  }
  return { rememberPage: source.rememberPage, rememberPosition: source.rememberPosition, lastPage: source.lastPage, position };
}

const providerName = (provider: ImageProvider): string => provider === 'openai' ? 'GPT' : 'NAI';

function imageProvider(value: unknown): ImageProvider {
  if (value !== 'novelai' && value !== 'openai') throw new Error('配置文件的生图类型无效。');
  return value;
}

function artistSettings(value: unknown, provider: ImageProvider): ArtistSettings {
  const source = object(value, '画师串');
  fields(source, ['artists', 'positive', 'negative', 'activeArtistId'], '画师串');
  const validated = validateImageSettings({ ...defaultImageSettings(provider), ...source });
  return { artists: validated.artists, positive: validated.positive, negative: validated.negative, activeArtistId: validated.activeArtistId };
}

function selectPreset(settings: ModelSettings): PresetSettings {
  const { presetName, head, tail, promptOrder, enabledLayers, parseImageMarkers, hideImageContext } = settings;
  return { presetName, head, tail, promptOrder, enabledLayers, parseImageMarkers, hideImageContext };
}

function presetSettings(value: unknown, provider: ImageProvider): PresetSettings {
  const source = object(value, '预设');
  fields(source, ['presetName', 'head', 'tail', 'promptOrder', 'enabledLayers', 'parseImageMarkers', 'hideImageContext'], '预设');
  return selectPreset(validateModelSettings({ ...defaultModelSettings(provider), ...source }));
}

function modelAttachments(model: AllModelSettings): WorldbookAttachments {
  return { novelai: model.presets.novelai.worldbooks, openai: model.presets.openai.worldbooks };
}

function worldbookSettings(value: unknown, version: 1 | 2): WorldbookSettings {
  const source = object(value, '世界书配置');
  fields(source, ['worldbooks', 'attachments'], '世界书配置');
  const worldbooks = validateWorldbookArchive(source.worldbooks);
  let raw: Record<string, unknown>;
  if (version === 1) {
    if (!Array.isArray(source.attachments)) throw new Error('旧版世界书挂载必须是数组。');
    raw = { novelai: source.attachments, openai: [] };
  } else {
    raw = object(source.attachments, '世界书挂载');
    fields(raw, ['novelai', 'openai'], '世界书挂载');
  }
  const attachments: WorldbookAttachments = {
    novelai: validateModelSettings({ ...defaultModelSettings('novelai'), worldbooks: raw.novelai }).worldbooks,
    openai: validateModelSettings({ ...defaultModelSettings('openai'), worldbooks: raw.openai }).worldbooks,
  };
  checkWorldbookLinks(attachments, worldbooks);
  return { worldbooks, attachments };
}

async function encodePortrait(blob: Blob | null): Promise<string | null> {
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32_768) binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  const encoded = `data:${blob.type};base64,${btoa(binary)}`;
  decodePortrait(encoded);
  return encoded;
}

function decodePortrait(value: unknown): Blob | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > Math.ceil(ANCHOR_PORTRAIT_LIMIT / 3) * 4 + 64) {
    throw new Error('角色图格式无效或超过 10 MiB。');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('角色图必须是内嵌的 PNG、JPEG 或 WebP。');
  let binary: string;
  try { binary = atob(match[2]); } catch { throw new Error('角色图编码损坏。'); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const valid = match[1] === 'image/png'
    ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP';
  if (!valid) throw new Error('角色图内容与图片类型不符。');
  return new Blob([bytes], { type: match[1] });
}

function anchors(value: unknown): CharacterAnchor[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('角色锚定列表无效。');
  return validateAnchorLibrary(value.map(raw => {
    const item = object(raw, '角色锚定');
    return { ...item, portrait: decodePortrait(item.portrait) };
  }));
}

function checkWorldbookLinks(attachments: WorldbookAttachments, books: StoredWorldbook[]): void {
  const available = new Map(books.map(book => [book.name, new Set(book.entries.map(entry => entry.id))]));
  for (const provider of IMAGE_PROVIDERS) {
    for (const selected of attachments[provider]) {
      const entries = available.get(selected.name);
      if (!entries || selected.entries.some(id => !entries.has(id))) {
        throw new Error(`${providerName(provider)} 世界书挂载“${selected.name}”缺少对应书籍或条目，无法完整迁移。`);
      }
    }
  }
}

function archiveConnections(archive: ParsedArchive): { key: string; url: string }[] {
  if (archive.kind !== 'all') return [];
  const { image, model } = archive.data;
  return [...IMAGE_PROVIDERS.flatMap(provider => {
    const settings = image.profiles[provider];
    return [settings.connection, ...settings.connectionProfiles];
  }), model.api];
}

export function archiveKeyCount(archive: ParsedArchive): number {
  return archiveConnections(archive).filter(connection => Boolean(connection.key)).length;
}

export function archiveUrlCount(archive: ParsedArchive): number {
  return archiveConnections(archive).filter(connection => connection.url.trim()).length;
}

export function parseArchive(source: string): ParsedArchive {
  if (source.length > MAX_ARCHIVE_BYTES || new TextEncoder().encode(source).byteLength > MAX_ARCHIVE_BYTES) throw new Error('配置文件不能超过 128 MiB。');
  let decoded: unknown;
  try { decoded = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是有效的 JSON。'); }
  const raw = object(decoded, '配置文件');
  fields(raw, ['format', 'version', 'kind', 'exportedAt', 'includesKeys', 'data'], '配置文件');
  if (raw.format !== 'witch-paintbox-config') throw new Error('请选择魔女画匣导出的配置文件；原始模型预设和世界书 JSON 请在各自页面导入。');
  if (raw.version !== 1 && raw.version !== 2) throw new Error('不支持这个配置文件版本，请更新插件后重试。');
  if (!['all', 'artists', 'presets', 'worldbooks'].includes(String(raw.kind)) || typeof raw.includesKeys !== 'boolean'
    || typeof raw.exportedAt !== 'string' || raw.exportedAt.length > 64 || !Number.isFinite(Date.parse(raw.exportedAt))) {
    throw new Error('配置文件的类型、时间或密钥标记无效。');
  }
  const base: Envelope = { format: 'witch-paintbox-config', version: raw.version, kind: raw.kind as ArchiveKind,
    exportedAt: raw.exportedAt, includesKeys: raw.includesKeys };
  const data = object(raw.data, '配置内容');
  let result: ParsedArchive;
  if (raw.kind !== 'all' && raw.includesKeys) throw new Error('局部配置文件不应包含密钥。');
  if (raw.kind === 'artists') {
    fields(data, raw.version === 1 ? ['artists'] : ['provider', 'artists'], '画师串分享文件');
    const provider = raw.version === 1 ? 'novelai' : imageProvider(data.provider);
    result = { ...base, kind: 'artists', data: { provider, artists: artistSettings(data.artists, provider) } };
  } else if (raw.kind === 'presets') {
    fields(data, raw.version === 1 ? ['presets'] : ['provider', 'presets'], '预设分享文件');
    const provider = raw.version === 1 ? 'novelai' : imageProvider(data.provider);
    result = { ...base, kind: 'presets', data: { provider, presets: presetSettings(data.presets, provider) } };
  } else if (raw.kind === 'worldbooks') {
    result = { ...base, kind: 'worldbooks', data: worldbookSettings(data, raw.version) };
  } else {
    const required = ['image', 'model', 'preferences', 'anchors', 'worldbooks'];
    fields(data, Object.hasOwn(data, 'sharedOutfits') ? [...required, 'sharedOutfits'] : required, '完整配置');
    let image: AllImageSettings, model: AllModelSettings;
    if (raw.version === 1) {
      const modelRaw = object(data.model, '模型配置');
      if (modelRaw.worldbookSource !== 'uploads') throw new Error('配置文件的世界书来源不受支持。');
      image = validateAllImageSettings(validateImageSettings({ ...object(data.image, '生图配置'), provider: 'novelai' }));
      model = validateAllModelSettings(validateModelSettings({ ...modelRaw, presetProvider: 'novelai' }));
    } else {
      const modelRaw = object(data.model, '模型配置');
      if (object(data.image, '生图配置').version !== 2 || modelRaw.version !== 2) {
        throw new Error('新版完整配置必须包含 NAI 与 GPT 两套配置。');
      }
      const presets = object(modelRaw.presets, '模型预设');
      for (const provider of IMAGE_PROVIDERS) {
        if (object(presets[provider], `${providerName(provider)} 预设`).worldbookSource !== 'uploads') {
          throw new Error(`${providerName(provider)} 预设的世界书来源不受支持。`);
        }
      }
      image = validateAllImageSettings(data.image);
      model = validateAllModelSettings(data.model);
    }
    const worldbooks = validateWorldbookArchive(data.worldbooks);
    checkWorldbookLinks(modelAttachments(model), worldbooks);
    const sharedOutfits = validateSharedOutfits(Object.hasOwn(data, 'sharedOutfits') ? data.sharedOutfits : []);
    result = { ...base, kind: 'all', data: { image, model, worldbooks, anchors: anchors(data.anchors), sharedOutfits, preferences: preferences(data.preferences) } };
  }
  if (!result.includesKeys && archiveKeyCount(result)) throw new Error('文件标记为不含密钥，但实际包含密钥，已停止导入。');
  return result;
}

export async function exportArchive(kind: ArchiveKind, includeKeys: boolean, context: TavernContext): Promise<Blob> {
  const envelope: Envelope = { format: 'witch-paintbox-config', version: 2, kind, exportedAt: new Date().toISOString(), includesKeys: kind === 'all' && includeKeys };
  let data: unknown;
  if (kind === 'artists') {
    const image = loadImageSettings();
    data = { provider: image.provider, artists: artistSettings({ artists: image.artists, positive: image.positive, negative: image.negative, activeArtistId: image.activeArtistId }, image.provider) };
  } else if (kind === 'presets') {
    const model = loadModelSettings();
    data = { provider: model.presetProvider, presets: selectPreset(model) };
  } else if (kind === 'worldbooks') {
    const attachments = modelAttachments(loadAllModelSettings());
    const worldbooks = await loadWorldbookArchive();
    checkWorldbookLinks(attachments, worldbooks);
    data = { worldbooks, attachments };
  } else {
    const image = loadAllImageSettings(), model = loadAllModelSettings();
    const [characters, worldbooks] = await Promise.all([loadAnchors(), loadWorldbookArchive()]);
    checkWorldbookLinks(modelAttachments(model), worldbooks);
    if (!includeKeys) {
      for (const provider of IMAGE_PROVIDERS) {
        const settings = image.profiles[provider];
        for (const connection of [settings.connection, ...settings.connectionProfiles]) {
          connection.key = '';
          connection.url = '';
        }
      }
      model.api.key = '';
      model.api.url = '';
    }
    const portable: PortableAnchor[] = [];
    for (const character of characters) portable.push({ ...character, portrait: await encodePortrait(character.portrait) });
    data = { image, model, preferences: readSettings(context), anchors: portable, sharedOutfits: loadSharedOutfits(), worldbooks };
  }
  const blob = new Blob([JSON.stringify({ ...envelope, data }, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('配置文件超过 128 MiB，请先减少角色图或世界书体积。');
  return blob;
}

export function summarizeArchive(archive: ParsedArchive): ArchiveSummary[] {
  const rows: ArchiveSummary[] = [];
  if (archive.version === 1) rows.push({ title: '旧版配置兼容', detail: archive.kind === 'all'
    ? '旧版单套配置将迁入 NAI；GPT 生图配置与预设将恢复为空的初始配置。'
    : archive.kind === 'worldbooks' ? '旧版世界书挂载归入 NAI；GPT 的挂载将清空，以免引用替换前的书籍。'
      : '旧版分享文件的目标为 NAI，不会替换 GPT 的画师串或预设。' });
  if (archive.kind === 'artists') {
    const artists = archive.data.artists;
    rows.push({ title: `${providerName(archive.data.provider)} 画师串`, detail: `${artists.artists.length} 个命名配置及当前提示词、选用状态。${artists.artists.map(item => item.name).join('、')}` });
    return rows;
  }
  if (archive.kind === 'presets') {
    const preset = archive.data.presets;
    rows.push({ title: `${providerName(archive.data.provider)} 预设`, detail: `“${preset.presetName || '未命名'}”，${preset.head.length + preset.tail.length} 个文本条目，含条目编排、功能层启用状态；配图标记开关为两套共用设置。` });
    return rows;
  }
  if (archive.kind === 'worldbooks') {
    const { worldbooks, attachments } = archive.data;
    rows.push({ title: '世界书', detail: `${worldbooks.length} 本、${worldbooks.reduce((total, book) => total + book.entries.length, 0)} 个条目。${worldbooks.map(book => book.name).join('、')}` });
    for (const provider of IMAGE_PROVIDERS) rows.push({ title: `${providerName(provider)} 条目挂载`, detail: `${attachments[provider].reduce((total, book) => total + book.entries.length, 0)} 个条目，来自 ${attachments[provider].filter(book => book.entries.length).length} 本书；该套世界书层的启用状态和预设位置保留当前设置。` });
    return rows;
  }
  const { image, model, anchors, sharedOutfits, worldbooks } = archive.data;
  rows.push({ title: '当前生图类型', detail: providerName(image.activeProvider) });
  for (const provider of IMAGE_PROVIDERS) {
    const settings = image.profiles[provider], preset = model.presets[provider];
    const parameters = provider === 'novelai' ? settings.parameters : settings.openaiParameters;
    rows.push({ title: `${providerName(provider)} 生图 API`, detail: `${settings.connectionProfiles.length} 个保存连接；模型 ${parameters.model || '未选模型'}，${parameters.width} × ${parameters.height}，含全部生图参数。` },
      { title: `${providerName(provider)} 画师串`, detail: `${settings.artists.length} 个命名配置及当前提示词。${settings.artists.map(item => item.name).join('、')}` },
      { title: `${providerName(provider)} 预设`, detail: `“${preset.presetName || '未命名'}”，${preset.head.length + preset.tail.length} 个文本条目，含编排、功能层选择和 ${preset.worldbooks.length} 本世界书挂载。` });
  }
  rows.push({ title: '共用模型 API', detail: `${model.api.mode === 'tavern' ? '跟随酒馆主 API' : `自定义接口 · ${model.api.model || '未选模型'}`}；含回复参数及配图标记开关。` },
    { title: '标签锚定', detail: `${anchors.length} 个角色、${anchors.reduce((total, anchor) => total + anchor.aliases.length, 0)} 个别名、${anchors.reduce((total, anchor) => total + anchor.outfits.length, 0)} 套服装、${anchors.filter(anchor => anchor.portrait).length} 张角色图。` },
    { title: '通用服装库', detail: `${sharedOutfits.length} 套通用服装；完整导入将替换当前通用服装库。${sharedOutfits.map(outfit => outfit.name).join('、')}` },
    { title: '世界书', detail: `${worldbooks.length} 本、${worldbooks.reduce((total, book) => total + book.entries.length, 0)} 个条目，含两套挂载关系。${worldbooks.map(book => book.name).join('、')}` },
    { title: '使用偏好', detail: '页面记忆、悬浮球位置及位置记忆。' });
  return rows;
}

/** Validate everything before writes; restore completed sections if a later storage operation fails. */
export async function applyArchive(archive: ParsedArchive, context: TavernContext): Promise<void> {
  if (archive.kind === 'artists') {
    const image = loadImageSettings(archive.data.provider);
    try { await saveImageSettings({ ...image, ...archive.data.artists }); }
    catch (error) {
      let restored = true;
      try { await saveImageSettings(image); } catch { restored = false; }
      throw new Error(`${error instanceof Error ? error.message : '画师串导入失败。'}${restored ? '原配置已恢复。' : '原配置未能恢复，请检查浏览器存储。'}`);
    }
    return;
  }
  if (archive.kind === 'presets') {
    const model = loadModelSettings(archive.data.provider);
    try { await saveModelSettings({ ...model, ...archive.data.presets }); }
    catch (error) { await rollback(error, [() => saveModelSettings(model)]); }
    return;
  }
  if (archive.kind === 'worldbooks') {
    const model = loadAllModelSettings(), previousBooks = await loadWorldbookArchive();
    const undo: (() => void | Promise<void>)[] = [];
    try {
      checkWorldbookLinks(archive.data.attachments, archive.data.worldbooks);
      await replaceWorldbookArchive(archive.data.worldbooks);
      undo.push(() => replaceWorldbookArchive(previousBooks));
      undo.push(() => saveAllModelSettings(model));
      const next = structuredClone(model);
      for (const provider of IMAGE_PROVIDERS) next.presets[provider].worldbooks = archive.data.attachments[provider];
      await saveAllModelSettings(next);
    } catch (error) { await rollback(error, undo); }
    return;
  }
  const image = loadAllImageSettings();
  const model = loadAllModelSettings(), previousPreferences = readSettings(context);
  const previousSharedOutfits = loadSharedOutfits();
  const [previousAnchors, previousBooks] = await Promise.all([loadAnchors(), loadWorldbookArchive()]);
  const undo: (() => void | Promise<void>)[] = [];
  try {
    await replaceAnchors(archive.data.anchors);
    undo.push(() => replaceAnchors(previousAnchors));
    undo.push(() => replaceSharedOutfits(previousSharedOutfits));
    await replaceSharedOutfits(archive.data.sharedOutfits);
    await replaceWorldbookArchive(archive.data.worldbooks);
    undo.push(() => replaceWorldbookArchive(previousBooks));
    undo.push(() => saveAllModelSettings(model));
    await saveAllModelSettings(archive.data.model);
    undo.push(() => saveAllImageSettings(image));
    await saveAllImageSettings(archive.data.image);
    undo.push(() => saveSettings(context, previousPreferences));
    saveSettings(context, archive.data.preferences);
  } catch (error) { await rollback(error, undo); }
}

async function rollback(error: unknown, undo: (() => void | Promise<void>)[]): Promise<never> {
  let failed = false;
  for (const restore of undo.reverse()) {
    try { await restore(); } catch { failed = true; }
  }
  throw new Error(`${error instanceof Error ? error.message : '配置导入失败。'}${failed ? '部分配置未能恢复，请保留导入文件并检查浏览器存储。' : '本次更改已撤回，原配置已恢复。'}`);
}
