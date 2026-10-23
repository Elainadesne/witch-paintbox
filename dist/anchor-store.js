export const ANCHOR_NAME_LIMIT = 80;
export const ANCHOR_TAG_LIMIT = 32_768;
export const ANCHOR_PORTRAIT_LIMIT = 10 * 1024 * 1024;
const databaseName = 'witch-paintbox-anchors';
const storeName = 'characters';
const listeners = new Set();
let connection = null;
function database() {
    if (connection)
        return connection;
    const pending = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail('打开角色锚定库超时，请关闭其他酒馆页面后重试。'), 15_000);
        function fail(message) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(message));
        }
        let request;
        try {
            request = window.indexedDB.open(databaseName, 1);
        }
        catch {
            fail('浏览器无法打开角色锚定库，请检查站点存储权限。');
            return;
        }
        request.onblocked = () => fail('角色锚定库被其他页面占用，请关闭其他酒馆页面后重试。');
        request.onerror = () => fail(request.error?.name === 'VersionError'
            ? '角色锚定库版本较新，请更新插件后重试。'
            : '浏览器未能打开角色锚定库，请检查存储权限或剩余空间。');
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
                if (!store.indexNames.contains('name'))
                    store.createIndex('name', 'name', { unique: true });
            }
            catch {
                request.transaction?.abort();
                fail('角色锚定库初始化失败，原有记录未修改。');
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
    if (error?.name === 'QuotaExceededError')
        return new Error(`角色锚定${action}失败，浏览器存储空间不足。`);
    if (error?.name === 'ConstraintError')
        return new Error('已有同名角色，请更换角色名称。');
    return new Error(`角色锚定${action}失败，请检查站点存储权限后重试。`);
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
            catch { /* Completion may already be pending. */ }
            fail(new Error(`角色锚定${action}超时，尚未确认完成，请重试。`));
        }, 30_000);
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                transaction.abort();
            }
            catch { /* The transaction may already have completed. */ }
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
function requiredText(value, label, limit) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`请填写${label}。`);
    const text = value.trim();
    if (text.length > limit)
        throw new Error(`${label}不能超过 ${limit} 个字符。`);
    return text;
}
function anchorName(value, label) {
    const name = requiredText(value, label, ANCHOR_NAME_LIMIT);
    if (/[,，\r\n/]/.test(name))
        throw new Error(`${label}不能包含逗号、换行或斜杠。`);
    if (/[\\()[\]{}<>]/.test(name) || name.includes('::'))
        throw new Error(`${label}不能包含英文括号、反斜杠或提示词权重符号。`);
    return name;
}
function snapshot(value) {
    const anchor = value;
    if (!anchor || !Array.isArray(anchor.outfits) || typeof anchor.selectedOutfitId !== 'string'
        || !Number.isFinite(anchor.updatedAt) || anchor.updatedAt < 0
        || (anchor.portrait !== null && !(anchor.portrait instanceof Blob))) {
        throw new Error('角色锚定记录格式无效，原有记录未修改。');
    }
    const ids = new Set();
    const names = new Set();
    const outfits = anchor.outfits.map(outfit => {
        const id = requiredText(outfit?.id, '服装标识', 128);
        const name = anchorName(outfit?.name, '服装名称');
        if (name === '无服装')
            throw new Error('“无服装”用于仅添加外貌，请为这套服装使用其他名称。');
        if (ids.has(id))
            throw new Error('服装标识重复，原有记录未修改。');
        if (names.has(name))
            throw new Error('同一角色内不能有同名服装。');
        ids.add(id);
        names.add(name);
        return { id, name, tags: requiredText(outfit?.tags, '服装标签', ANCHOR_TAG_LIMIT) };
    });
    const selectedOutfitId = anchor.selectedOutfitId.trim();
    if (selectedOutfitId && !ids.has(selectedOutfitId))
        throw new Error('选中的服装不存在，请重新选择。');
    if (anchor.portrait && (!anchor.portrait.size || anchor.portrait.size > ANCHOR_PORTRAIT_LIMIT)) {
        throw new Error('封面图片不能为空，且不能超过 10 MB。');
    }
    const name = anchorName(anchor.name, '角色名称');
    if (!/\p{Script=Han}/u.test(name))
        throw new Error('请使用包含中文汉字的角色名称，以便与英文生图 tag 区分。');
    return {
        id: requiredText(anchor.id, '角色标识', 128),
        name,
        appearance: requiredText(anchor.appearance, '固定外貌标签', ANCHOR_TAG_LIMIT),
        outfits, selectedOutfitId,
        // A stored Blob is independent of gallery records and their object URLs.
        portrait: anchor.portrait?.slice(0, anchor.portrait.size, anchor.portrait.type) ?? null,
        updatedAt: anchor.updatedAt,
    };
}
function notify() {
    for (const listener of listeners) {
        try {
            listener();
        }
        catch (error) {
            console.warn('[魔女画匣] 角色锚定更新监听失败。', error);
        }
    }
}
export function newAnchorId() {
    return `${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(3)), value => value.toString(36)).join('-')}`;
}
export function onAnchorsChanged(callback) {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
}
export async function loadAnchors() {
    const anchors = await transact('readonly', '读取', store => store.getAll());
    return anchors.map(snapshot).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
export function validateAnchor(value) {
    return snapshot(value);
}
export async function replaceAnchors(value) {
    if (!Array.isArray(value))
        throw new Error('角色锚定备份必须是数组，原有记录未修改。');
    const saved = Array.from(value, validateAnchor);
    const ids = new Set();
    const names = new Set();
    for (const anchor of saved) {
        if (ids.has(anchor.id))
            throw new Error('角色锚定备份中角色标识重复，原有记录未修改。');
        if (names.has(anchor.name))
            throw new Error('角色锚定备份中角色名称重复，原有记录未修改。');
        ids.add(anchor.id);
        names.add(anchor.name);
    }
    await transact('readwrite', '恢复', store => {
        const cleared = store.clear();
        for (const anchor of saved)
            store.put(anchor);
        // transact resolves only after every request commits, including all puts.
        return cleared;
    });
    notify();
}
export async function saveAnchor(anchor) {
    const saved = snapshot(anchor);
    // The unique name index also rejects concurrent same-name saves in other tabs.
    await transact('readwrite', '保存', store => store.put(saved));
    notify();
}
export async function deleteAnchor(id) {
    const key = requiredText(id, '角色标识', 128);
    await transact('readwrite', '删除', store => store.delete(key));
    notify();
}
