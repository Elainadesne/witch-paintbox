import { validateOpenAIImageParameters } from './openai-image.js';
/** Positive tags for display and manual character selection, not for recreating a request. */
export function imageHistoryPositive(entry) {
    return [entry.positive, ...(entry.characters ?? []).map(character => character.positive)]
        .filter(Boolean).join(',\n');
}
const databaseName = 'witch-paintbox-image-history';
const storeName = 'images';
let connection = null;
const changeListeners = new Set();
let channel = null;
/** Keep open tabs from retaining deleted blobs; only record IDs and cutoffs cross the channel. */
export function bindImageHistorySync(signal) {
    if (signal.aborted || channel || typeof BroadcastChannel !== 'function')
        return;
    try {
        channel = new BroadcastChannel('witch-paintbox-image-history');
    }
    catch {
        return;
    }
    const current = channel;
    current.onmessage = event => {
        const value = event.data;
        if (!value || typeof value !== 'object')
            return;
        const change = {};
        if (typeof value.savedId === 'string')
            change.savedId = value.savedId;
        if (Array.isArray(value.deletedIds) && value.deletedIds.every((id) => typeof id === 'string'))
            change.deletedIds = value.deletedIds;
        if (typeof value.before === 'number' && Number.isFinite(value.before) && value.before > 0)
            change.before = value.before;
        if (Object.keys(change).length)
            notifyChanged(change, false);
    };
    signal.addEventListener('abort', () => { current.close(); if (channel === current)
        channel = null; }, { once: true });
}
export function onImageHistoryChanged(callback) {
    changeListeners.add(callback);
    return () => { changeListeners.delete(callback); };
}
function notifyChanged(change, broadcast = true) {
    if (broadcast) {
        try {
            channel?.postMessage(change);
        }
        catch { /* Local listeners still update. */ }
    }
    for (const listener of changeListeners) {
        try {
            listener(change);
        }
        catch { /* View failures must not undo committed image history. */ }
    }
}
function database() {
    if (connection)
        return connection;
    const pending = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail('打开图片历史超时，请关闭其他酒馆页面后重试。'), 15_000);
        function fail(message) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(message));
        }
        let request;
        try {
            request = window.indexedDB.open(databaseName, 2);
        }
        catch {
            fail('浏览器无法打开图片历史，请检查站点存储权限。');
            return;
        }
        request.onblocked = () => fail('图片历史被其他页面占用，请关闭其他酒馆页面后重试。');
        request.onerror = () => fail('浏览器未能打开图片历史，请检查存储权限或剩余空间。');
        request.onupgradeneeded = () => {
            if (settled) {
                request.transaction?.abort();
                return;
            }
            try {
                const db = request.result;
                const store = db.objectStoreNames.contains(storeName)
                    ? request.transaction.objectStore(storeName)
                    : db.createObjectStore(storeName, { keyPath: 'id' });
                if (!store.indexNames.contains('markerKey'))
                    store.createIndex('markerKey', 'markerKey', { unique: false });
                if (!store.indexNames.contains('createdAt'))
                    store.createIndex('createdAt', ['createdAt', 'id']);
                if (!store.indexNames.contains('scopeCreatedAt'))
                    store.createIndex('scopeCreatedAt', ['scope', 'createdAt', 'id']);
                // Backfill ownership from existing keys, without loading the full archive into memory.
                const cursor = store.openCursor();
                cursor.onsuccess = () => {
                    const row = cursor.result;
                    if (!row)
                        return;
                    row.update({ ...row.value, scope: historyScope(row.value.markerKey) });
                    row.continue();
                };
            }
            catch {
                request.transaction?.abort();
                fail('图片历史存储初始化失败。');
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            if (settled) {
                db.close();
                return;
            }
            settled = true;
            clearTimeout(timer);
            const invalidate = () => { if (connection === pending)
                connection = null; };
            db.onversionchange = () => { invalidate(); db.close(); };
            db.onclose = invalidate;
            resolve(db);
        };
    });
    connection = pending;
    void pending.catch(() => { if (connection === pending)
        connection = null; });
    return pending;
}
function operationError(action, error) {
    return new Error(error?.name === 'QuotaExceededError'
        ? `图片历史${action}失败，浏览器存储空间不足。`
        : `图片历史${action}失败，请检查站点存储权限后重试。`);
}
async function transact(mode, action, makeRequest) {
    const db = await database();
    return new Promise((resolve, reject) => {
        let transaction;
        try {
            transaction = db.transaction(storeName, mode);
        }
        catch {
            connection = null;
            db.close();
            reject(operationError(action));
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            try {
                transaction.abort();
            }
            catch { /* The transaction may already be finishing. */ }
            fail(new Error(`图片历史${action}超时，尚未确认完成，请重试。`));
        }, 30_000);
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        let request;
        transaction.onabort = () => fail(operationError(action, transaction.error));
        transaction.onerror = () => fail(operationError(action, transaction.error));
        transaction.oncomplete = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(request.result);
        };
        try {
            request = makeRequest(transaction.objectStore(storeName));
            request.onerror = () => fail(operationError(action, request.error));
        }
        catch {
            try {
                transaction.abort();
            }
            catch { /* Failure is reported below. */ }
            fail(operationError(action));
        }
    });
}
function snapshot(value) {
    const entry = value;
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.markerKey !== 'string' || !entry.markerKey
        || !(entry.blob instanceof Blob) || !entry.blob.size
        || !Number.isFinite(entry.createdAt) || entry.createdAt < 0
        || typeof entry.positive !== 'string' || typeof entry.negative !== 'string'
        || (entry.scenePrompt !== undefined && typeof entry.scenePrompt !== 'string')
        || (entry.provider !== undefined && entry.provider !== 'novelai' && entry.provider !== 'openai')) {
        throw new Error('图片历史记录格式无效，原有记录未修改。');
    }
    let characters;
    if (entry.characters !== undefined) {
        if (!Array.isArray(entry.characters) || entry.characters.length > 22) {
            throw new Error('图片历史的角色分栏格式无效，原有记录未修改。');
        }
        characters = [];
        for (const character of entry.characters) {
            if (!character || typeof character.positive !== 'string' || !character.positive.trim()
                || typeof character.negative !== 'string') {
                throw new Error('图片历史的角色分栏格式无效，原有记录未修改。');
            }
            characters.push({ positive: character.positive, negative: character.negative });
        }
    }
    const common = {
        id: entry.id, markerKey: entry.markerKey, blob: entry.blob, createdAt: entry.createdAt,
        positive: entry.positive, negative: entry.negative,
        ...(characters === undefined ? {} : { characters }),
        ...(entry.scenePrompt === undefined ? {} : { scenePrompt: entry.scenePrompt }),
        scope: historyScope(entry.markerKey),
        ...(typeof entry.title === 'string' ? { title: entry.title.slice(0, 400) } : {}),
        ...(typeof entry.sourceName === 'string' ? { sourceName: entry.sourceName.slice(0, 200) } : {}),
    };
    // Copy only image metadata: connection credentials and arbitrary extra fields never enter this store.
    if (entry.provider === 'openai') {
        // A compatible provider may return a different canvas; retain its validated PNG dimensions.
        const parameters = validateOpenAIImageParameters(entry.parameters, 'image');
        if (!parameters.model || entry.negative || characters?.length || entry.seed !== undefined) {
            throw new Error('GPT 图片历史记录格式无效，原有记录未修改。');
        }
        return { ...common, provider: 'openai', parameters };
    }
    const parameters = entry.parameters;
    if (!Number.isInteger(entry.seed) || entry.seed < 0 || entry.seed > 4_294_967_295
        || !parameters || typeof parameters.model !== 'string' || typeof parameters.sampler !== 'string'
        || typeof parameters.noiseSchedule !== 'string' || typeof parameters.sm !== 'boolean' || typeof parameters.smDyn !== 'boolean'
        || ![parameters.width, parameters.height, parameters.steps, parameters.scale, parameters.cfgRescale].every(Number.isFinite)) {
        throw new Error('图片历史记录格式无效，原有记录未修改。');
    }
    return {
        ...common, provider: 'novelai', seed: entry.seed,
        parameters: {
            model: parameters.model, width: parameters.width, height: parameters.height,
            steps: parameters.steps, scale: parameters.scale, sampler: parameters.sampler,
            seed: entry.seed, noiseSchedule: parameters.noiseSchedule, cfgRescale: parameters.cfgRescale,
            sm: parameters.sm, smDyn: parameters.smDyn,
        },
    };
}
export async function loadImageHistory(markerKey) {
    if (typeof markerKey !== 'string' || !markerKey)
        throw new Error('图片标记标识无效，无法读取历史。');
    const entries = await transact('readonly', '读取', store => store.index('markerKey').getAll(markerKey));
    return entries.map(snapshot).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export async function saveImageHistory(entry) {
    const saved = snapshot(entry);
    await transact('readwrite', '保存', store => store.put(saved));
    notifyChanged({ savedId: saved.id });
}
export async function deleteImageHistory(id) {
    if (typeof id !== 'string' || !id)
        throw new Error('图片历史标识无效，无法删除。');
    await transact('readwrite', '删除', store => store.delete(id));
    notifyChanged({ deletedIds: [id] });
}
export function historyScope(markerKey) {
    try {
        const key = JSON.parse(markerKey);
        if (Array.isArray(key) && typeof key[0] === 'string')
            return key[0];
    }
    catch { /* Legacy records without an identifiable card remain in All images. */ }
    return 'unassigned';
}
export function historySourceName(scope, sourceName) {
    if (sourceName?.trim() && sourceName !== '当前群聊')
        return sourceName;
    try {
        const key = JSON.parse(scope);
        if (Array.isArray(key) && key[1] !== undefined && key[1] !== null) {
            if (key[0] === 'group')
                return `群聊 · ${key[1]}`;
            if (key[0] === 'character')
                return String(key[1]).replace(/\.png$/i, '');
        }
    }
    catch { /* Images created without an open card have no card identity. */ }
    return '未归属图片';
}
export function historyTitle(entry) {
    if (entry.title)
        return entry.title;
    try {
        const key = JSON.parse(entry.markerKey);
        const raw = key[key.length - 3];
        if (typeof raw === 'string')
            return /^<img>\s*\[([^\]\r\n]+)\]/.exec(raw)?.[1] ?? '配图';
    }
    catch { /* Keep old images viewable even when their title cannot be recovered. */ }
    return '配图';
}
export function historyWasDeleted(entry, change) {
    return Boolean(change.deletedIds?.includes(entry.id) || change.before !== undefined && entry.createdAt < change.before);
}
async function walkHistory(mode, action, open, visit, result, permitted = () => true) {
    const db = await database();
    if (!permitted())
        return result();
    return new Promise((resolve, reject) => {
        let transaction;
        try {
            transaction = db.transaction(storeName, mode);
        }
        catch {
            connection = null;
            reject(operationError(action));
            return;
        }
        const timer = setTimeout(() => {
            try {
                transaction.abort();
            }
            catch { /* May already be committed. */ }
            reject(new Error(`图片历史${action}超时，请稍后重试。`));
        }, 30_000);
        transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(operationError(action, transaction.error)); };
        transaction.oncomplete = () => { clearTimeout(timer); resolve(result()); };
        try {
            const store = transaction.objectStore(storeName);
            const request = open(store);
            request.onsuccess = () => {
                try {
                    if (!permitted()) {
                        transaction.abort();
                        return;
                    }
                    const cursor = request.result;
                    if (cursor && visit(cursor, store))
                        cursor.continue();
                }
                catch {
                    transaction.abort();
                }
            };
        }
        catch {
            transaction.abort();
        }
    });
}
/** Read only the newest record for each card; skip its remaining images via the scope index. */
export async function loadImageHistoryCategories() {
    const categories = [];
    return walkHistory('readonly', '分类读取', store => store.index('scopeCreatedAt').openCursor(null, 'prev'), cursor => {
        const scope = cursor.key[0];
        if (typeof scope !== 'string')
            return true;
        const sourceName = cursor.value.sourceName;
        categories.push({ scope, name: historySourceName(scope, typeof sourceName === 'string' ? sourceName : undefined) });
        cursor.continue([scope]);
        return false; // continue([scope]) jumps to the previous card instead of the previous image.
    }, () => categories.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)));
}
/** At most one page of blobs is retained; pagination is stable for equal timestamps. */
export async function loadImageHistoryPage(scope, before, limit = 12) {
    const entries = [];
    let more = false;
    const size = Math.max(1, Math.min(24, Math.floor(limit)));
    const range = scope === null
        ? before ? IDBKeyRange.upperBound(before, true) : undefined
        : IDBKeyRange.bound([scope], before ? [scope, ...before] : [scope, Number.MAX_VALUE, []], false, Boolean(before));
    return walkHistory('readonly', '读取', store => store.index(scope === null ? 'createdAt' : 'scopeCreatedAt').openCursor(range, 'prev'), cursor => {
        let entry;
        try {
            entry = snapshot(cursor.value);
        }
        catch {
            return true;
        }
        if (entries.length === size) {
            more = true;
            return false;
        }
        entries.push(entry);
        return true;
    }, () => {
        const last = entries.at(-1);
        return { entries, more, next: last ? [last.createdAt, last.id] : null };
    });
}
/** Delete via timestamp keys rather than reading every image blob. */
export async function deleteExpiredImages(before, permitted = () => true) {
    if (!Number.isFinite(before) || before <= 0)
        return 0;
    let count = 0;
    await walkHistory('readwrite', '清理', store => store.index('createdAt').openKeyCursor(IDBKeyRange.upperBound([before], true)), (cursor, store) => {
        store.delete(cursor.primaryKey);
        count++;
        return true;
    }, () => count, permitted);
    if (count)
        notifyChanged({ before });
    return count;
}
