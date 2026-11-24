import { getHostStore, readHostJson, withHostLock, writeHostJson } from './host-storage.js';
const databaseName = 'witch-paintbox-worldbooks';
const storeName = 'books';
const namesStoreName = 'names';
const nameLimit = 512;
const entryLimit = 10_000;
const listeners = new Set();
let connection = null;
const hostTable = 'worldbooks';
const hostLock = 'worldbook-library';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
function database() {
    if (connection)
        return connection;
    const pending = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail('半天没打开世界书库，把多余的酒馆页面关掉再试试。'), 15_000);
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
            fail('浏览器打不开世界书库，看看是不是站点存储权限被拦住了。');
            return;
        }
        request.onblocked = () => fail('世界书库正被别的页面占着，关掉其他酒馆页再试试。');
        request.onerror = () => fail(request.error?.name === 'VersionError'
            ? '世界书库的数据版本比当前画匣新，把插件升到新版再试。'
            : '浏览器没打开世界书库，查一下存储权限或硬盘还够不够空间。');
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
                fail('世界书库初始化没成功，原来的书都还在没动。');
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
        ? `世界书${action}没存上，浏览器存储空间不够了。`
        : `世界书${action}没成功，查一下站点存储权限再试。`);
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
        const timer = setTimeout(() => fail(new Error(`世界书${action}等太久了，还没确认写成，再试一次。`)), 30_000);
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
        throw new Error('世界书不能没名字，也不能超过 512 个字。');
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
    throw new Error('世界书里有个条目标识不对劲（得是非负整数或非空字符串）。');
}
function activationBoolean(value, fallback, label) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value !== 'boolean')
        throw new Error(`世界书激活设置里的 ${label} 必须是开关布尔值。`);
    return value;
}
function activationKeys(value, label) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > entryLimit
        || value.some(key => typeof key !== 'string' || key.length > 32_768)) {
        throw new Error(`世界书激活设置里的 ${label} 必须是文本列表。`);
    }
    return [...value];
}
function activationLogic(value) {
    if (value === undefined || value === null)
        return 0;
    if (value !== 0 && value !== 1 && value !== 2 && value !== 3) {
        throw new Error('世界书的 selectiveLogic 只能是 0、1、2 或 3。');
    }
    return value;
}
function parseActivation(entry, source) {
    if (source === 'stored') {
        // Missing metadata in an older library/backup cannot safely imply either blue or green.
        if (entry.activation === undefined || entry.activation === null)
            return null;
        const saved = record(entry.activation);
        if (!saved || ['constant', 'selective', 'caseSensitive', 'matchWholeWords'].some(key => typeof saved[key] !== 'boolean')
            || !Array.isArray(saved.keys) || !Array.isArray(saved.secondaryKeys)
            || ![0, 1, 2, 3].includes(saved.selectiveLogic)) {
            throw new Error('存着的世界书激活设置坏掉了，找原世界书重导一遍吧。');
        }
        return {
            constant: saved.constant,
            keys: activationKeys(saved.keys, 'keys'),
            secondaryKeys: activationKeys(saved.secondaryKeys, 'secondaryKeys'),
            selective: saved.selective,
            selectiveLogic: activationLogic(saved.selectiveLogic),
            caseSensitive: saved.caseSensitive,
            matchWholeWords: saved.matchWholeWords,
        };
    }
    const extensions = entry.extensions === undefined ? null : record(entry.extensions);
    if (entry.extensions !== undefined && !extensions)
        throw new Error('世界书条目的 extensions 必须是对象。');
    // ST recognizes /pattern/flags directly in keys; there is no separate regex switch.
    return {
        constant: activationBoolean(entry.constant, false, 'constant'),
        keys: activationKeys(entry.key ?? entry.keys, 'key/keys'),
        secondaryKeys: activationKeys(entry.keysecondary ?? entry.secondary_keys, 'keysecondary/secondary_keys'),
        selective: activationBoolean(entry.selective, source === 'native', 'selective'),
        selectiveLogic: activationLogic(entry.selectiveLogic ?? extensions?.selectiveLogic),
        caseSensitive: activationBoolean(entry.caseSensitive ?? extensions?.case_sensitive ?? entry.case_sensitive, false, 'caseSensitive'),
        matchWholeWords: activationBoolean(entry.matchWholeWords ?? extensions?.match_whole_words, false, 'matchWholeWords'),
    };
}
function parseEntries(value, source = 'stored') {
    const object = record(value);
    const array = Array.isArray(value);
    if (!array && !object)
        throw new Error('这本世界书里缺了 entries，看着不像酒馆世界书。');
    const rows = array ? value.map((entry, index) => [String(index), entry]) : Object.entries(object);
    if (rows.length > entryLimit)
        throw new Error('一本世界书最多装 10000 条，这本太厚了。');
    const used = new Set();
    return rows.map(([key, raw]) => {
        const entry = record(raw);
        if (!entry)
            throw new Error(`第 ${key} 号世界书条目格式不对。`);
        // CharacterBook permits omitted IDs; the import index becomes its persisted ID.
        const id = entryId(entry.uid ?? entry.id ?? key);
        if ((entry.uid !== undefined && entryId(entry.uid) !== id)
            || (entry.id !== undefined && entryId(entry.id) !== id)
            || (!array && (!/^\d+$/.test(key) || entryId(key) !== id))) {
            throw new Error(`世界书条目 ${key} 的标识不一致。`);
        }
        if (used.has(id))
            throw new Error(`世界书里条目标识“${id}”写重了，改完再导进来吧。`);
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
            enabled: typeof entry.enabled === 'boolean' ? entry.enabled : entry.disable !== true,
            activation: parseActivation(entry, source) };
    });
}
function parseBook(value, filename) {
    const root = record(value);
    if (!root)
        throw new Error('世界书 JSON 最外层格式不对。');
    const wrapped = root.character_book !== undefined ? root.character_book : record(root.data)?.character_book;
    const source = wrapped === undefined ? root : record(wrapped);
    if (!source)
        throw new Error('文件里的 character_book 那一段格式不对。');
    if (source.name !== undefined && typeof source.name !== 'string')
        throw new Error('世界书名称必须是文本。');
    const filenameName = typeof filename === 'string' ? filename.replace(/\.json$/i, '').trim() : '';
    const name = bookName(typeof source.name === 'string' && source.name.trim() ? source.name : filenameName || '未命名世界书');
    return { name, entries: parseEntries(source.entries, wrapped !== undefined || Array.isArray(source.entries) ? 'character' : 'native') };
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
        throw new Error('世界书备份格式不对，原来的书没动。');
    const names = new Set();
    return Array.from(value, raw => {
        const book = record(raw);
        if (!book || !Array.isArray(book.entries))
            throw new Error('世界书备份里有本书格式不对，原来的书没动。');
        const name = bookName(book.name);
        if (name !== book.name)
            throw new Error('备份里的世界书名字前后多了空格，原来的书没动。');
        if (names.has(name))
            throw new Error(`备份里有两本都叫“${name}”，原来的书没动。`);
        names.add(name);
        const entries = parseEntries(book.entries);
        for (let index = 0; index < entries.length; index++) {
            const entry = record(book.entries[index]);
            if (entry.id !== entries[index].id || entry.name !== entries[index].name || typeof entry.enabled !== 'boolean') {
                throw new Error(`“${name}”的备份条目里标识、名字或开关状态坏了，原来的书没动。`);
            }
        }
        return { name, entries };
    });
}
export async function loadWorldbookArchive() {
    if (getHostStore())
        return withHostLock(hostLock, async () => {
            const manifest = await nativeManifest();
            const books = [];
            for (const reference of manifest.books)
                books.push(await readNativeBook(reference));
            return books.sort((a, b) => a.name.localeCompare(b.name));
        });
    const books = await transact('readonly', '备份读取', (store, result) => {
        store.getAll().onsuccess = event => result(event.target.result);
    });
    return validateWorldbookArchive(books).sort((a, b) => a.name.localeCompare(b.name));
}
export async function replaceWorldbookArchive(books) {
    const saved = validateWorldbookArchive(books);
    if (getHostStore()) {
        await withHostLock(hostLock, async () => {
            const previous = await nativeManifest();
            await publishBooks(saved, previous.reservedNames);
        });
        notify();
        return;
    }
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
/** Lists only books imported into this plugin. Native hosts sync the library through their extension store. */
export async function listWorldbooks(signal) {
    if (getHostStore())
        return withHostLock(hostLock, async () => {
            const manifest = await nativeManifest(signal);
            signal?.throwIfAborted();
            return manifest.books.map(book => book.name).sort((a, b) => a.localeCompare(b));
        });
    const keys = await transact('readonly', '读取', (store, result) => {
        store.getAllKeys().onsuccess = event => result(event.target.result);
    }, signal);
    signal?.throwIfAborted();
    return keys.map(bookName).sort((a, b) => a.localeCompare(b));
}
export async function readWorldbook(name, signal) {
    signal?.throwIfAborted();
    const key = bookName(name);
    if (getHostStore())
        return withHostLock(hostLock, async () => {
            const manifest = await nativeManifest(signal);
            const reference = manifest.books.find(book => book.name === key);
            if (!reference)
                throw new Error(`画匣书库里找不着“${key}”，重新传一遍或者把这里的挂载取消吧。`);
            return (await readNativeBook(reference, signal)).entries;
        });
    const value = await transact('readonly', '读取', (store, result) => {
        store.get(key).onsuccess = event => result(event.target.result);
    }, signal);
    signal?.throwIfAborted();
    const book = record(value);
    if (!book)
        throw new Error(`画匣书库里找不着“${key}”，重新传一遍或者把这里的挂载取消吧。`);
    if (book.name !== key)
        throw new Error('存着的世界书名字和索引对不上，原来的记录没动。');
    return parseEntries(book.entries);
}
/** Update only one entry's text against the latest stored book, retaining its identity and activation rules. */
export async function updateWorldbookEntryContent(name, id, content, previous) {
    const key = bookName(name), target = entryId(id);
    const update = (book) => {
        const entry = book.entries.find(entry => entry.id === target);
        if (!entry)
            throw new Error('这条世界书刚才被删掉了，没存进去。');
        if (entry.content !== previous && entry.content !== content) {
            throw new Error('这条刚才在别处被改过了，先把你刚写的内容复制出来，刷新一下页面再改吧。');
        }
        entry.content = content;
        return entry;
    };
    let entry;
    if (getHostStore()) {
        entry = await withHostLock(hostLock, async () => {
            const manifest = await nativeManifest();
            const index = manifest.books.findIndex(book => book.name === key);
            if (index < 0)
                throw new Error(`“${key}”这本书已经被删掉了，刚才的修改没存进去。`);
            const book = await readNativeBook(manifest.books[index]);
            const saved = update(book);
            manifest.books[index] = await writeNativeBook(book);
            await writeHostJson('manifest', manifest, hostTable);
            return saved;
        });
    }
    else {
        entry = await transact('readwrite', '内容保存', (store, result, fail) => {
            const request = store.get(key);
            request.onsuccess = () => {
                try {
                    if (!request.result)
                        throw new Error(`“${key}”这本书已经被删掉了，刚才的修改没存进去。`);
                    const [book] = validateWorldbookArchive([request.result]);
                    if (book.name !== key)
                        throw new Error('存着的世界书名字对不上，刚才的修改没存进去。');
                    const saved = update(book);
                    store.put(book).onsuccess = () => result(saved);
                }
                catch (error) {
                    fail(error instanceof Error ? error : operationError('内容保存'));
                }
            };
        });
    }
    notify();
    return entry;
}
/** Add and choose a unique name in one transaction, including simultaneous imports from other tabs. */
export async function importWorldbook(value, filename) {
    const book = parseBook(value, filename);
    if (getHostStore()) {
        const name = await withHostLock(hostLock, async () => {
            const manifest = await nativeManifest();
            const name = uniqueBookName(book.name, new Set(manifest.reservedNames));
            const reference = await writeNativeBook({ ...book, name });
            await writeHostJson('manifest', { version: 1, books: [...manifest.books, reference],
                reservedNames: [...manifest.reservedNames, name] }, hostTable);
            return name;
        });
        notify();
        return name;
    }
    const name = await transact('readwrite', '导入', (store, result, fail) => {
        const registry = store.transaction.objectStore(namesStoreName);
        const reserved = registry.getAllKeys();
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
            try {
                // Requests run in order within this transaction; both key lists are now available.
                const used = new Set([...reserved.result, ...keys.result]);
                const unique = uniqueBookName(book.name, used);
                registry.add(true, unique);
                const request = store.add({ ...book, name: unique });
                request.onsuccess = () => result(unique);
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error('世界书没导进去，原来书库里的东西都没动。'));
            }
        };
    });
    notify();
    return name;
}
export async function deleteWorldbook(name) {
    const key = bookName(name);
    if (getHostStore()) {
        await withHostLock(hostLock, async () => {
            const manifest = await nativeManifest();
            await writeHostJson('manifest', { ...manifest, books: manifest.books.filter(book => book.name !== key) }, hostTable);
        });
        notify();
        return;
    }
    // Keep the name reserved so a stale selection in another tab cannot bind to a later upload.
    await transact('readwrite', '删除', (store, result) => {
        store.delete(key).onsuccess = () => result(undefined);
    });
    notify();
}
function uniqueBookName(name, used) {
    let unique = name;
    for (let count = 2; used.has(unique); count++) {
        const suffix = ` (${count})`;
        unique = name.slice(0, nameLimit - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
    }
    return unique;
}
function validateNativeManifest(value) {
    const manifest = record(value);
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.books) || !Array.isArray(manifest.reservedNames)) {
        throw new Error('同步过来的世界书目录格式不对，本地书库没动，先看看同步状态吧。');
    }
    const names = new Set(), keys = new Set();
    const books = manifest.books.map(raw => {
        const reference = record(raw);
        if (!reference || typeof reference.key !== 'string' || !/^book-[a-f0-9-]{36}$/.test(reference.key)) {
            throw new Error('同步过来的世界书文件标识不对。');
        }
        const name = bookName(reference.name);
        if (name !== reference.name || names.has(name) || keys.has(reference.key))
            throw new Error('同步过来的世界书目录里有重复或坏掉的标识。');
        names.add(name);
        keys.add(reference.key);
        return { name, key: reference.key };
    });
    const reservedNames = manifest.reservedNames.map(raw => {
        const name = bookName(raw);
        if (name !== raw)
            throw new Error('同步过来的世界书名称前后多了空白或不对。');
        return name;
    });
    const reserved = new Set(reservedNames);
    if (reserved.size !== reservedNames.length || books.some(book => !reserved.has(book.name))) {
        throw new Error('同步过来的世界书目录缺了几页。');
    }
    return { version: 1, books, reservedNames };
}
async function nativeManifest(signal) {
    signal?.throwIfAborted();
    const stored = await readHostJson('manifest', hostTable);
    signal?.throwIfAborted();
    if (stored.found)
        return validateNativeManifest(stored.value);
    const old = await transact('readonly', '迁移读取', (store, result) => {
        const books = store.getAll();
        const names = store.transaction.objectStore(namesStoreName).getAllKeys();
        names.onsuccess = () => result({ books: books.result, names: names.result });
    }, signal);
    const books = validateWorldbookArchive(old.books);
    const reserved = old.names.map(bookName);
    return publishBooks(books, reserved, signal);
}
async function readNativeBook(reference, signal) {
    signal?.throwIfAborted();
    const stored = await readHostJson(reference.key, hostTable);
    signal?.throwIfAborted();
    if (!stored.found)
        throw new Error(`“${reference.name}”的同步文件还没传完，等同步好再试试。`);
    const [book] = validateWorldbookArchive([stored.value]);
    if (book.name !== reference.name)
        throw new Error('同步过来的书名和目录对不上，原来的书没动。');
    return book;
}
async function writeNativeBook(book, signal) {
    signal?.throwIfAborted();
    // ASCII immutable keys keep names independent of filesystem/path restrictions.
    const key = `book-${crypto.randomUUID()}`;
    await writeHostJson(key, book, hostTable);
    signal?.throwIfAborted();
    return { name: book.name, key };
}
async function publishBooks(books, reservedNames, signal) {
    const references = [];
    for (const book of books)
        references.push(await writeNativeBook(book, signal));
    const manifest = { version: 1, books: references,
        reservedNames: [...new Set([...reservedNames, ...books.map(book => book.name)])] };
    signal?.throwIfAborted();
    // Switching the small manifest publishes the complete batch. Old files remain for in-flight sync readers.
    await writeHostJson('manifest', manifest, hostTable);
    signal?.throwIfAborted();
    return manifest;
}
export async function initializeWorldbookHostStorage() {
    if (getHostStore())
        await withHostLock(hostLock, async () => { await nativeManifest(); });
}
