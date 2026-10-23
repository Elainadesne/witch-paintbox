const databaseName = 'witch-paintbox-worldbooks';
const storeName = 'books';
const namesStoreName = 'names';
const nameLimit = 512;
const entryLimit = 10_000;
const listeners = new Set();
let connection = null;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
function database() {
    if (connection)
        return connection;
    const pending = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail('打开插件世界书库超时，请关闭其他酒馆页面后重试。'), 15_000);
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
            fail('浏览器无法打开插件世界书库，请检查站点存储权限。');
            return;
        }
        request.onblocked = () => fail('插件世界书库被其他页面占用，请关闭其他酒馆页面后重试。');
        request.onerror = () => fail(request.error?.name === 'VersionError'
            ? '世界书库版本较新，请更新插件后重试。'
            : '浏览器未能打开插件世界书库，请检查存储权限或剩余空间。');
        request.onupgradeneeded = () => {
            if (settled) {
                request.transaction?.abort();
                return;
            }
            try {
                const db = request.result;
                if (!db.objectStoreNames.contains(storeName))
                    db.createObjectStore(storeName, { keyPath: 'name' });
                if (!db.objectStoreNames.contains(namesStoreName))
                    db.createObjectStore(namesStoreName);
            }
            catch {
                request.transaction?.abort();
                fail('插件世界书库初始化失败，原有记录未修改。');
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
        ? `世界书${action}失败，浏览器存储空间不足。`
        : `世界书${action}失败，请检查站点存储权限后重试。`);
}
async function transact(mode, action, run, signal) {
    signal?.throwIfAborted();
    const db = await database();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        let transaction;
        try {
            transaction = db.transaction([storeName, namesStoreName], mode);
        }
        catch {
            connection = null;
            db.close();
            reject(operationError(action));
            return;
        }
        let settled = false;
        let result;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            try {
                transaction.abort();
            }
            catch { /* The transaction may already have completed. */ }
            reject(error);
        };
        const cancel = () => fail(new DOMException('读取已取消。', 'AbortError'));
        const timer = setTimeout(() => fail(new Error(`世界书${action}超时，尚未确认完成，请重试。`)), 30_000);
        signal?.addEventListener('abort', cancel, { once: true });
        transaction.onabort = () => fail(operationError(action, transaction.error));
        transaction.onerror = () => fail(operationError(action, transaction.error));
        transaction.oncomplete = () => {
            if (settled)
                return;
            if (signal?.aborted) {
                cancel();
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        };
        try {
            run(transaction.objectStore(storeName), value => { result = value; }, fail);
        }
        catch (error) {
            fail(error instanceof Error ? error : operationError(action));
        }
    });
}
function bookName(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > nameLimit) {
        throw new Error('世界书名称不能为空，且不能超过 512 个字符。');
    }
    return value.trim();
}
function entryId(value) {
    if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value >= 0)
            return String(value);
    }
    else if (typeof value === 'string' && value.trim() === value && value.length && value.length <= 512
        && !/[\u0000-\u001f]/.test(value)) {
        if (!/^\d+$/.test(value))
            return value;
        const numeric = Number(value);
        if (Number.isSafeInteger(numeric))
            return String(numeric);
    }
    throw new Error('世界书含有无效条目标识；请使用非负整数或非空字符串。');
}
function parseEntries(value) {
    const object = record(value);
    const array = Array.isArray(value);
    if (!array && !object)
        throw new Error('世界书需要 entries 对象或数组。');
    const rows = array ? value.map((entry, index) => [String(index), entry]) : Object.entries(object);
    if (rows.length > entryLimit)
        throw new Error('每本世界书最多导入 10000 条。');
    const used = new Set();
    return rows.map(([key, raw]) => {
        const entry = record(raw);
        if (!entry)
            throw new Error(`世界书条目 ${key} 格式无效。`);
        // CharacterBook permits omitted IDs; the import index becomes its persisted ID.
        const id = entryId(entry.uid ?? entry.id ?? key);
        if ((entry.uid !== undefined && entryId(entry.uid) !== id)
            || (entry.id !== undefined && entryId(entry.id) !== id)
            || (!array && (!/^\d+$/.test(key) || entryId(key) !== id))) {
            throw new Error(`世界书条目 ${key} 的标识不一致。`);
        }
        if (used.has(id))
            throw new Error(`世界书中条目标识“${id}”重复，请先修正后导入。`);
        used.add(id);
        if (typeof entry.content !== 'string')
            throw new Error(`世界书条目 ${id} 的 content 必须是文本。`);
        if ((entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
            || (entry.disable !== undefined && typeof entry.disable !== 'boolean')) {
            throw new Error(`世界书条目 ${id} 的 enabled/disable 必须是布尔值。`);
        }
        if (typeof entry.enabled === 'boolean' && typeof entry.disable === 'boolean' && entry.enabled === entry.disable) {
            throw new Error(`世界书条目 ${id} 的 enabled 与 disable 相互冲突。`);
        }
        if ((entry.name !== undefined && typeof entry.name !== 'string')
            || (entry.comment !== undefined && typeof entry.comment !== 'string')) {
            throw new Error(`世界书条目 ${id} 的名称必须是文本。`);
        }
        const name = (typeof entry.comment === 'string' ? entry.comment.trim() : '')
            || (typeof entry.name === 'string' ? entry.name.trim() : '') || `条目 ${id}`;
        return { id, name, content: entry.content,
            enabled: typeof entry.enabled === 'boolean' ? entry.enabled : entry.disable !== true };
    });
}
function parseBook(value, filename) {
    const root = record(value);
    if (!root)
        throw new Error('世界书 JSON 顶层必须是对象。');
    const wrapped = root.character_book !== undefined ? root.character_book : record(root.data)?.character_book;
    const source = wrapped === undefined ? root : record(wrapped);
    if (!source)
        throw new Error('character_book 格式无效。');
    if (source.name !== undefined && typeof source.name !== 'string')
        throw new Error('世界书名称必须是文本。');
    const filenameName = typeof filename === 'string' ? filename.replace(/\.json$/i, '').trim() : '';
    const name = bookName(typeof source.name === 'string' && source.name.trim() ? source.name : filenameName || '未命名世界书');
    return { name, entries: parseEntries(source.entries) };
}
function notify() {
    for (const listener of listeners) {
        try {
            listener();
        }
        catch { /* A view error must not undo committed local books. */ }
    }
}
export function onWorldbooksChanged(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function validateWorldbookArchive(value) {
    if (!Array.isArray(value))
        throw new Error('世界书备份必须是数组，原有记录未修改。');
    const names = new Set();
    return Array.from(value, raw => {
        const book = record(raw);
        if (!book || !Array.isArray(book.entries))
            throw new Error('世界书备份格式无效，原有记录未修改。');
        const name = bookName(book.name);
        if (name !== book.name)
            throw new Error('世界书备份名称不能包含首尾空白，原有记录未修改。');
        if (names.has(name))
            throw new Error(`世界书备份中名称“${name}”重复，原有记录未修改。`);
        names.add(name);
        const entries = parseEntries(book.entries);
        for (let index = 0; index < entries.length; index++) {
            const entry = record(book.entries[index]);
            if (entry.id !== entries[index].id || entry.name !== entries[index].name || typeof entry.enabled !== 'boolean') {
                throw new Error(`世界书“${name}”的备份条目标识、名称或启用状态无效，原有记录未修改。`);
            }
        }
        return { name, entries };
    });
}
export async function loadWorldbookArchive() {
    const books = await transact('readonly', '备份读取', (store, result) => {
        store.getAll().onsuccess = event => result(event.target.result);
    });
    return validateWorldbookArchive(books).sort((a, b) => a.name.localeCompare(b.name));
}
export async function replaceWorldbookArchive(books) {
    const saved = validateWorldbookArchive(books);
    await transact('readwrite', '恢复', store => {
        const registry = store.transaction.objectStore(namesStoreName);
        store.clear();
        for (const book of saved) {
            store.put(book);
            // Restore explicit backup names while retaining reservations from older uploads.
            registry.put(true, book.name);
        }
    });
    notify();
}
/** Lists only books imported into this plugin's browser storage. */
export async function listWorldbooks(signal) {
    const keys = await transact('readonly', '读取', (store, result) => {
        store.getAllKeys().onsuccess = event => result(event.target.result);
    }, signal);
    signal?.throwIfAborted();
    return keys.map(bookName).sort((a, b) => a.localeCompare(b));
}
export async function readWorldbook(name, signal) {
    signal?.throwIfAborted();
    const key = bookName(name);
    const value = await transact('readonly', '读取', (store, result) => {
        store.get(key).onsuccess = event => result(event.target.result);
    }, signal);
    signal?.throwIfAborted();
    const book = record(value);
    if (!book)
        throw new Error(`插件中没有世界书“${key}”，请重新导入或移除挂载。`);
    if (book.name !== key)
        throw new Error('已保存的世界书标识无效，原记录未修改。');
    return parseEntries(book.entries);
}
/** Add and choose a unique name in one transaction, including simultaneous imports from other tabs. */
export async function importWorldbook(value, filename) {
    const book = parseBook(value, filename);
    const name = await transact('readwrite', '导入', (store, result, fail) => {
        const registry = store.transaction.objectStore(namesStoreName);
        const reserved = registry.getAllKeys();
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
            try {
                // Requests run in order within this transaction; both key lists are now available.
                const used = new Set([...reserved.result, ...keys.result]);
                let unique = book.name;
                for (let count = 2; used.has(unique); count++) {
                    const suffix = ` (${count})`;
                    const base = book.name.slice(0, nameLimit - suffix.length).replace(/[\uD800-\uDBFF]$/, '');
                    unique = base + suffix;
                }
                registry.add(true, unique);
                const request = store.add({ ...book, name: unique });
                request.onsuccess = () => result(unique);
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error('世界书导入失败，原有记录未修改。'));
            }
        };
    });
    notify();
    return name;
}
export async function deleteWorldbook(name) {
    const key = bookName(name);
    // Keep the name reserved so a stale selection in another tab cannot bind to a later upload.
    await transact('readwrite', '删除', (store, result) => {
        store.delete(key).onsuccess = () => result(undefined);
    });
    notify();
}
