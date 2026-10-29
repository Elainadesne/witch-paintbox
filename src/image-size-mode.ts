import type { ModelSettings, PromptEntry } from './model-settings.js';

export type ImageSizeMode = 'fixed' | 'ai';
type SizeProtocolSettings = Pick<ModelSettings, 'head' | 'tail'>;

export const SIZE_PROTOCOL_NAMES: Record<ImageSizeMode, string> = {
  fixed: '📐 格式｜默认画幅·三字段输出协议',
  ai: '📐 格式｜AI动态画幅·四字段输出协议',
};

function protocolName(name: string): string {
  // The icon and typography are presentation; still match the entire protocol name.
  return name.normalize('NFKC').replace(/^\s*📐\uFE0F?/u, '').replace(/\s+/gu, '');
}

export function imageSizeEntryMode(entry: Pick<PromptEntry, 'name' | 'marker'> & Partial<Pick<PromptEntry, 'id'>>): ImageSizeMode | null {
  if (entry.marker) return null;
  const name = protocolName(entry.name);
  if (name === protocolName(SIZE_PROTOCOL_NAMES.fixed)) return 'fixed';
  if (name === protocolName(SIZE_PROTOCOL_NAMES.ai)) return 'ai';
  // Imported identifier values are already mapped to id; a recognized name takes precedence.
  if (entry.id === 'output-format-fixed-size') return 'fixed';
  if (entry.id === 'output-format-ai-size') return 'ai';
  return null;
}

export function imageSizeMode(settings: SizeProtocolSettings): ImageSizeMode {
  const enabled = [...settings.head, ...settings.tail].filter(entry => entry.enabled);
  return enabled.some(entry => imageSizeEntryMode(entry) === 'ai')
    && !enabled.some(entry => imageSizeEntryMode(entry) === 'fixed') ? 'ai' : 'fixed';
}

/** Change only the two named protocol groups; other draft fields remain untouched. */
export function applyImageSizeMode<T extends SizeProtocolSettings>(settings: T, mode: ImageSizeMode): T {
  const update = (entries: PromptEntry[]) => entries.map(entry => {
    const entryMode = imageSizeEntryMode(entry);
    return entryMode ? { ...entry, enabled: entryMode === mode } : entry;
  });
  return { ...settings, head: update(settings.head), tail: update(settings.tail) };
}

export function selectImageSizeMode<T extends SizeProtocolSettings>(settings: T, mode: ImageSizeMode): T {
  if (![...settings.head, ...settings.tail].some(entry => imageSizeEntryMode(entry) === mode)) {
    throw new Error(`请先在当前生图接口的模型 API 预设中导入并保存“${SIZE_PROTOCOL_NAMES[mode]}”条目。`);
  }
  return applyImageSizeMode(settings, mode);
}

/** Old presets and deliberately disabled protocols remain valid; conflicts prefer fixed size. */
export function normalizeSizeProtocolEntries<T extends SizeProtocolSettings>(settings: T): T {
  if (![...settings.head, ...settings.tail].some(entry => entry.enabled && imageSizeEntryMode(entry) === 'fixed')) return settings;
  const update = (entries: PromptEntry[]) => entries.map(entry =>
    entry.enabled && imageSizeEntryMode(entry) === 'ai' ? { ...entry, enabled: false } : entry);
  return { ...settings, head: update(settings.head), tail: update(settings.tail) };
}
