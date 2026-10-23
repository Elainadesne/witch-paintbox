import { defaultImageSettings, loadImageSettings, saveImageSettings, validateImageSettings, type ImageSettings } from './image-settings.js';
import { defaultModelSettings, loadModelSettings, saveModelSettings, validateModelSettings, type ModelSettings } from './model-settings.js';
import { loadAnchors, replaceAnchors, validateAnchor, ANCHOR_PORTRAIT_LIMIT, type CharacterAnchor } from './anchor-store.js';
import { loadWorldbookArchive, replaceWorldbookArchive, validateWorldbookArchive, type StoredWorldbook } from './worldbook-source.js';
import { readSettings, saveSettings, type Settings, type TavernContext } from './settings.js';
import { isPageId } from './pages.js';

export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export type ArchiveKind = 'all' | 'artists' | 'presets' | 'worldbooks';
type ArtistSettings = Pick<ImageSettings, 'artists' | 'positive' | 'negative' | 'activeArtistId'>;
type PresetSettings = Pick<ModelSettings, 'presetName' | 'head' | 'tail' | 'promptOrder' | 'enabledLayers' | 'parseImageMarkers' | 'hideImageContext'>;
interface WorldbookSettings { worldbooks: StoredWorldbook[]; attachments: ModelSettings['worldbooks'] }
type PortableAnchor = Omit<CharacterAnchor, 'portrait'> & { portrait: string | null };
interface CompleteSettings {
  image: ImageSettings;
  model: ModelSettings;
  preferences: Settings;
  anchors: CharacterAnchor[];
  worldbooks: StoredWorldbook[];
}
interface Envelope {
  format: 'witch-paintbox-config';
  version: 1;
  kind: ArchiveKind;
  exportedAt: string;
  includesKeys: boolean;
}
export type ParsedArchive = Envelope & (
  { kind: 'all'; data: CompleteSettings }
  | { kind: 'artists'; data: { artists: ArtistSettings } }
  | { kind: 'presets'; data: { presets: PresetSettings } }
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

function artistSettings(value: unknown): ArtistSettings {
  const source = object(value, '画师串');
  fields(source, ['artists', 'positive', 'negative', 'activeArtistId'], '画师串');
  const validated = validateImageSettings({ ...defaultImageSettings(), ...source });
  return { artists: validated.artists, positive: validated.positive, negative: validated.negative, activeArtistId: validated.activeArtistId };
}

function selectPreset(settings: ModelSettings): PresetSettings {
  const { presetName, head, tail, promptOrder, enabledLayers, parseImageMarkers, hideImageContext } = settings;
  return { presetName, head, tail, promptOrder, enabledLayers, parseImageMarkers, hideImageContext };
}

function presetSettings(value: unknown): PresetSettings {
  const source = object(value, '预设');
  fields(source, ['presetName', 'head', 'tail', 'promptOrder', 'enabledLayers', 'parseImageMarkers', 'hideImageContext'], '预设');
  return selectPreset(validateModelSettings({ ...defaultModelSettings(), ...source }));
}

function worldbookSettings(value: unknown): WorldbookSettings {
  const source = object(value, '世界书配置');
  fields(source, ['worldbooks', 'attachments'], '世界书配置');
  if (!Array.isArray(source.attachments)) throw new Error('世界书挂载必须是数组。');
  const worldbooks = validateWorldbookArchive(source.worldbooks);
  const attachments = validateModelSettings({ ...defaultModelSettings(), worldbooks: source.attachments }).worldbooks;
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
  const rows = value.map(raw => {
    const item = object(raw, '角色锚定');
    return validateAnchor({ ...item, portrait: decodePortrait(item.portrait) });
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.name)).size !== rows.length) {
    throw new Error('角色锚定存在重复标识或名称。');
  }
  return rows;
}

function checkWorldbookLinks(attachments: ModelSettings['worldbooks'], books: StoredWorldbook[]): void {
  for (const selected of attachments) {
    const book = books.find(book => book.name === selected.name);
    if (!book || selected.entries.some(id => !book.entries.some(entry => entry.id === id))) {
      throw new Error(`世界书挂载“${selected.name}”缺少对应书籍或条目，无法完整迁移。`);
    }
  }
}

export function archiveKeyCount(archive: ParsedArchive): number {
  if (archive.kind !== 'all') return 0;
  const { image, model } = archive.data;
  return [image.connection.key, ...image.connectionProfiles.map(profile => profile.key), model.key].filter(Boolean).length;
}

export function parseArchive(source: string): ParsedArchive {
  let decoded: unknown;
  try { decoded = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是有效的 JSON。'); }
  const raw = object(decoded, '配置文件');
  fields(raw, ['format', 'version', 'kind', 'exportedAt', 'includesKeys', 'data'], '配置文件');
  if (raw.format !== 'witch-paintbox-config') throw new Error('请选择魔女画匣导出的配置文件；原始模型预设和世界书 JSON 请在各自页面导入。');
  if (raw.version !== 1) throw new Error('不支持这个配置文件版本，请更新插件后重试。');
  if (!['all', 'artists', 'presets', 'worldbooks'].includes(String(raw.kind)) || typeof raw.includesKeys !== 'boolean'
    || typeof raw.exportedAt !== 'string' || raw.exportedAt.length > 64 || !Number.isFinite(Date.parse(raw.exportedAt))) {
    throw new Error('配置文件的类型、时间或密钥标记无效。');
  }
  const base: Envelope = { format: 'witch-paintbox-config', version: 1, kind: raw.kind as ArchiveKind,
    exportedAt: raw.exportedAt, includesKeys: raw.includesKeys };
  const data = object(raw.data, '配置内容');
  let result: ParsedArchive;
  if (raw.kind !== 'all' && raw.includesKeys) throw new Error('局部配置文件不应包含密钥。');
  if (raw.kind === 'artists') {
    fields(data, ['artists'], '画师串分享文件');
    result = { ...base, kind: 'artists', data: { artists: artistSettings(data.artists) } };
  } else if (raw.kind === 'presets') {
    fields(data, ['presets'], '预设分享文件');
    result = { ...base, kind: 'presets', data: { presets: presetSettings(data.presets) } };
  } else if (raw.kind === 'worldbooks') {
    result = { ...base, kind: 'worldbooks', data: worldbookSettings(data) };
  } else {
    fields(data, ['image', 'model', 'preferences', 'anchors', 'worldbooks'], '完整配置');
    const image = validateImageSettings(data.image);
    const modelRaw = object(data.model, '模型配置');
    if (modelRaw.worldbookSource !== 'uploads') throw new Error('配置文件的世界书来源不受支持。');
    const model = validateModelSettings(modelRaw);
    const worldbooks = validateWorldbookArchive(data.worldbooks);
    checkWorldbookLinks(model.worldbooks, worldbooks);
    result = { ...base, kind: 'all', data: { image, model, worldbooks, anchors: anchors(data.anchors), preferences: preferences(data.preferences) } };
  }
  if (!result.includesKeys && archiveKeyCount(result)) throw new Error('文件标记为不含密钥，但实际包含密钥，已停止导入。');
  return result;
}

export async function exportArchive(kind: ArchiveKind, includeKeys: boolean, context: TavernContext): Promise<Blob> {
  const envelope: Envelope = { format: 'witch-paintbox-config', version: 1, kind, exportedAt: new Date().toISOString(), includesKeys: kind === 'all' && includeKeys };
  let data: unknown;
  if (kind === 'artists') {
    const image = loadImageSettings();
    data = { artists: artistSettings({ artists: image.artists, positive: image.positive, negative: image.negative, activeArtistId: image.activeArtistId }) };
  } else if (kind === 'presets') data = { presets: selectPreset(loadModelSettings()) };
  else if (kind === 'worldbooks') {
    const model = loadModelSettings();
    const worldbooks = await loadWorldbookArchive();
    checkWorldbookLinks(model.worldbooks, worldbooks);
    data = { worldbooks, attachments: model.worldbooks };
  } else {
    const image = loadImageSettings();
    const model = loadModelSettings();
    const [characters, worldbooks] = await Promise.all([loadAnchors(), loadWorldbookArchive()]);
    checkWorldbookLinks(model.worldbooks, worldbooks);
    if (!includeKeys) {
      image.connection.key = '';
      image.connectionProfiles.forEach(profile => { profile.key = ''; });
      model.key = '';
    }
    const portable: PortableAnchor[] = [];
    for (const character of characters) portable.push({ ...character, portrait: await encodePortrait(character.portrait) });
    data = { image, model, preferences: readSettings(context), anchors: portable, worldbooks };
  }
  const blob = new Blob([JSON.stringify({ ...envelope, data }, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('配置文件超过 128 MiB，请先减少角色图或世界书体积。');
  return blob;
}

export function summarizeArchive(archive: ParsedArchive): ArchiveSummary[] {
  if (archive.kind === 'presets') {
    const preset = archive.data.presets;
    return [{ title: '预设', detail: `“${preset.presetName || '未命名'}”，${preset.head.length + preset.tail.length} 个文本条目，含条目编排、功能层启用状态和标记设置。` }];
  }
  if (archive.kind === 'worldbooks') {
    const { worldbooks, attachments } = archive.data;
    return [{ title: '世界书', detail: `${worldbooks.length} 本、${worldbooks.reduce((total, book) => total + book.entries.length, 0)} 个条目。${worldbooks.map(book => book.name).join('、')}` },
      { title: '条目挂载', detail: `${attachments.reduce((total, book) => total + book.entries.length, 0)} 个条目，来自 ${attachments.filter(book => book.entries.length).length} 本书；世界书层的启用状态和预设位置保留当前设置。` }];
  }
  const image = archive.kind === 'all' ? archive.data.image : archive.data.artists;
  const rows = [{ title: '画师串', detail: `${image.artists.length} 个命名配置及当前正、负面提示词。${image.artists.map(item => item.name).join('、')}` }];
  if (archive.kind === 'all') {
    const { model, anchors, worldbooks } = archive.data;
    rows.unshift({ title: '生图 API', detail: `${archive.data.image.connectionProfiles.length} 个保存连接；模型 ${archive.data.image.parameters.model}，${archive.data.image.parameters.width} × ${archive.data.image.parameters.height}，含全部生图参数。` },
      { title: '模型 API 与预设', detail: `${model.mode === 'tavern' ? '跟随酒馆主 API' : `自定义接口 · ${model.model || '未选模型'}`}；预设“${model.presetName || '未命名'}”，${model.head.length + model.tail.length} 个文本条目，含编排、功能层选择和标记设置。` });
    rows.push({ title: '标签锚定', detail: `${anchors.length} 个角色、${anchors.reduce((total, anchor) => total + anchor.outfits.length, 0)} 套服装、${anchors.filter(anchor => anchor.portrait).length} 张角色图。` },
      { title: '世界书', detail: `${worldbooks.length} 本、${worldbooks.reduce((total, book) => total + book.entries.length, 0)} 个条目，含挂载关系。${worldbooks.map(book => book.name).join('、')}` },
      { title: '使用偏好', detail: '页面记忆、悬浮球位置及位置记忆。' });
  }
  return rows;
}

/** Validate everything before writes; restore completed sections if a later storage operation fails. */
export async function applyArchive(archive: ParsedArchive, context: TavernContext): Promise<void> {
  if (archive.kind === 'artists') {
    const image = loadImageSettings();
    try { saveImageSettings({ ...image, ...archive.data.artists }); }
    catch (error) {
      let restored = true;
      try { saveImageSettings(image); } catch { restored = false; }
      throw new Error(`${error instanceof Error ? error.message : '画师串导入失败。'}${restored ? '原配置已恢复。' : '原配置未能恢复，请检查浏览器存储。'}`);
    }
    return;
  }
  if (archive.kind === 'presets') {
    const model = loadModelSettings();
    try { saveModelSettings({ ...model, ...archive.data.presets }); }
    catch (error) { await rollback(error, [() => saveModelSettings(model)]); }
    return;
  }
  if (archive.kind === 'worldbooks') {
    const model = loadModelSettings(), previousBooks = await loadWorldbookArchive();
    const undo: (() => void | Promise<void>)[] = [];
    try {
      checkWorldbookLinks(archive.data.attachments, archive.data.worldbooks);
      await replaceWorldbookArchive(archive.data.worldbooks);
      undo.push(() => replaceWorldbookArchive(previousBooks));
      undo.push(() => saveModelSettings(model));
      saveModelSettings({ ...model, worldbooks: archive.data.attachments });
    } catch (error) { await rollback(error, undo); }
    return;
  }
  const image = loadImageSettings();
  const model = loadModelSettings(), previousPreferences = readSettings(context);
  const [previousAnchors, previousBooks] = await Promise.all([loadAnchors(), loadWorldbookArchive()]);
  const undo: (() => void | Promise<void>)[] = [];
  try {
    await replaceAnchors(archive.data.anchors);
    undo.push(() => replaceAnchors(previousAnchors));
    await replaceWorldbookArchive(archive.data.worldbooks);
    undo.push(() => replaceWorldbookArchive(previousBooks));
    undo.push(() => saveImageSettings(image));
    saveImageSettings(archive.data.image);
    undo.push(() => saveModelSettings(model));
    saveModelSettings(archive.data.model);
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
