import { ANCHOR_NAME_LIMIT, ANCHOR_TAG_LIMIT } from './anchor-store.js';
const storageKey = 'witch-paintbox.shared-outfits.v1';
const listeners = new Set();
function requiredText(value, label, limit) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`请填写${label}。`);
    const text = value.trim();
    if (text.length > limit)
        throw new Error(`${label}不能超过 ${limit} 个字符。`);
    return text;
}
export function validateSharedOutfits(value) {
    if (!Array.isArray(value) || value.length > 10_000)
        throw new Error('通用服装库格式无效，原有记录未修改。');
    const ids = new Set(), names = new Set();
    return Array.from(value, raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('通用服装记录格式无效，原有记录未修改。');
        const outfit = raw;
        const id = requiredText(outfit.id, '通用服装标识', 128);
        const name = requiredText(outfit.name, '通用服装名称', ANCHOR_NAME_LIMIT);
        if (/[,，\r\n/]/.test(name))
            throw new Error('通用服装名称不能包含逗号、换行或斜杠。');
        if (/[\\()[\]{}<>]/.test(name) || name.includes('::'))
            throw new Error('通用服装名称不能包含英文括号、反斜杠或提示词权重符号。');
        if (ids.has(id))
            throw new Error('通用服装标识重复，原有记录未修改。');
        if (names.has(name))
            throw new Error(`通用服装“${name}”重名，请更换名称。`);
        ids.add(id);
        names.add(name);
        return { id, name, tags: requiredText(outfit.tags, '通用服装标签', ANCHOR_TAG_LIMIT) };
    });
}
function parseSaved(raw) {
    try {
        return validateSharedOutfits(JSON.parse(raw));
    }
    catch {
        throw new Error('已保存的通用服装库无法读取，原始记录已保留，未覆盖。');
    }
}
function readStored() {
    try {
        const storage = window.localStorage;
        return { storage, raw: storage.getItem(storageKey) };
    }
    catch {
        throw new Error('浏览器无法读取通用服装库，请检查站点存储权限。');
    }
}
function notify() {
    for (const listener of listeners) {
        try {
            listener();
        }
        catch (error) {
            console.warn('[魔女画匣] 通用服装库更新监听失败。', error);
        }
    }
}
function handleStorage(event) {
    if (event.key === storageKey || event.key === null)
        notify();
}
export function onSharedOutfitsChanged(callback) {
    if (!listeners.size)
        window.addEventListener('storage', handleStorage);
    listeners.add(callback);
    return () => {
        listeners.delete(callback);
        if (!listeners.size)
            window.removeEventListener('storage', handleStorage);
    };
}
export function loadSharedOutfits() {
    const { raw } = readStored();
    return raw === null ? [] : parseSaved(raw);
}
export function replaceSharedOutfits(value) {
    const outfits = validateSharedOutfits(value);
    const { storage, raw: previous } = readStored();
    // Preserve unreadable records instead of replacing them with an empty UI state.
    if (previous !== null)
        parseSaved(previous);
    const raw = JSON.stringify(outfits);
    if (raw === previous)
        return;
    try {
        storage.setItem(storageKey, raw);
        if (storage.getItem(storageKey) !== raw)
            throw new Error();
    }
    catch {
        // Only undo our own write; a different tab may already have saved newer data.
        try {
            if (storage.getItem(storageKey) === raw) {
                if (previous === null)
                    storage.removeItem(storageKey);
                else
                    storage.setItem(storageKey, previous);
            }
        }
        catch { /* Report the storage failure without discarding the previous snapshot. */ }
        throw new Error('浏览器未能保存通用服装库，请检查存储权限或剩余空间后重试。');
    }
    notify();
}
export function saveSharedOutfit(outfit) {
    const [saved] = validateSharedOutfits([outfit]);
    const outfits = loadSharedOutfits();
    const index = outfits.findIndex(item => item.id === saved.id);
    if (index === -1)
        outfits.push(saved);
    else
        outfits[index] = saved;
    replaceSharedOutfits(outfits);
}
export function deleteSharedOutfit(id) {
    const outfits = loadSharedOutfits();
    if (!outfits.some(outfit => outfit.id === id))
        return;
    replaceSharedOutfits(outfits.filter(outfit => outfit.id !== id));
}
