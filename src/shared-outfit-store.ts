import { createSettingsStorage } from './host-settings.js';
import { getHostStore } from './host-storage.js';
import { ANCHOR_NAME_LIMIT, ANCHOR_TAG_LIMIT, type AnchorOutfit } from './anchor-store.js';

export type SharedOutfit = AnchorOutfit;

const storageKey = 'witch-paintbox.shared-outfits.v1';
const listeners = new Set<() => void>();

function requiredText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${label}。`);
  const text = value.trim();
  if (text.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符。`);
  return text;
}

export function validateSharedOutfits(value: unknown): SharedOutfit[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('通用服装库格式无效，原有记录未修改。');
  const ids = new Set<string>(), names = new Set<string>();
  return Array.from(value, raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('通用服装记录格式无效，原有记录未修改。');
    const outfit = raw as Record<string, unknown>;
    const id = requiredText(outfit.id, '通用服装标识', 128);
    const name = requiredText(outfit.name, '通用服装名称', ANCHOR_NAME_LIMIT);
    if (/[,，\r\n/]/.test(name)) throw new Error('通用服装名称不能包含逗号、换行或斜杠。');
    if (/[\\()[\]{}<>]/.test(name) || name.includes('::')) throw new Error('通用服装名称不能包含英文括号、反斜杠或提示词权重符号。');
    if (ids.has(id)) throw new Error('通用服装标识重复，原有记录未修改。');
    if (names.has(name)) throw new Error(`通用服装“${name}”重名，请更换名称。`);
    ids.add(id); names.add(name);
    return { id, name, tags: requiredText(outfit.tags, '通用服装标签', ANCHOR_TAG_LIMIT) };
  });
}

function notify(): void {
  for (const listener of listeners) {
    try { listener(); }
    catch (error) { console.warn('[魔女画匣] 通用服装库更新监听失败。', error); }
  }
}

function handleStorage(event: StorageEvent): void {
  if (!getHostStore() && (event.key === storageKey || event.key === null)) notify();
}

export function onSharedOutfitsChanged(callback: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', handleStorage);
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (!listeners.size) window.removeEventListener('storage', handleStorage);
  };
}

const settingsStorage = createSettingsStorage<SharedOutfit[]>({
  localKey: storageKey, hostKey: 'shared-outfits-v1', label: '通用服装库',
  defaults: () => [], validate: validateSharedOutfits, changed: notify,
});

export function loadSharedOutfits(): SharedOutfit[] { return settingsStorage.load(); }
export function replaceSharedOutfits(value: unknown): Promise<void> {
  return settingsStorage.save(validateSharedOutfits(value));
}

export async function saveSharedOutfit(outfit: SharedOutfit): Promise<void> {
  const [saved] = validateSharedOutfits([outfit]);
  await settingsStorage.update(outfits => {
    const index = outfits.findIndex(item => item.id === saved.id);
    if (index === -1) outfits.push(saved);
    else outfits[index] = saved;
    return outfits;
  });
}

export async function deleteSharedOutfit(id: string): Promise<void> {
  await settingsStorage.update(outfits => outfits.filter(outfit => outfit.id !== id));
}
