import { getHostStore, readHostJson, withHostLock, writeHostJson } from './host-storage.js';
const participants = [];
const writeLock = 'settings';
let syncApiKeys = false;
let ready = false;
export function getSyncApiKeys() { return !!getHostStore() && syncApiKeys; }
export async function initializeSettingsStorage() {
    // Load every domain before restoring its synchronous read cache.
    await Promise.all([import('./image-settings.js'), import('./model-settings.js'), import('./shared-outfit-store.js')]);
    if (!getHostStore()) {
        ready = true;
        return;
    }
    const options = await readHostJson('sync-options-v1');
    if (options.found) {
        const value = options.value;
        if (!value || typeof value !== 'object' || typeof value.includeApiKeys !== 'boolean') {
            throw new Error('TT 同步选项格式无效，原始记录已保留。');
        }
        syncApiKeys = value.includeApiKeys;
    }
    for (const participant of participants)
        await participant.initialize();
    ready = true;
}
export async function setSyncApiKeys(enabled) {
    if (!getHostStore() || !ready)
        throw new Error('当前宿主的配置同步尚未就绪。');
    await withHostLock(writeLock, async () => {
        if (enabled === syncApiKeys)
            return;
        const operations = participants.map(item => item.prepareKeySync(enabled)).filter(item => item !== null);
        const attempted = [];
        try {
            for (const operation of operations) {
                attempted.push(operation);
                await operation.write();
            }
            await writeHostJson('sync-options-v1', { includeApiKeys: enabled });
            syncApiKeys = enabled;
        }
        catch {
            let restored = true;
            try {
                await writeHostJson('sync-options-v1', { includeApiKeys: syncApiKeys });
            }
            catch {
                restored = false;
            }
            for (const operation of attempted.reverse()) {
                try {
                    await operation.rollback();
                }
                catch {
                    restored = false;
                }
            }
            throw new Error(`密钥同步选项未能保存。${restored ? '原选项保持不变。' : '部分原生配置未能恢复，请重试后再同步。'}`);
        }
    });
}
/** Keep browser storage as the local key copy; TT owns the synchronized snapshot. */
export function createSettingsStorage(descriptor) {
    let cached;
    let nativeValue;
    let initialized = false;
    let exists = false;
    function localRecord() {
        let storage, raw;
        try {
            storage = window.localStorage;
            raw = storage.getItem(descriptor.localKey);
        }
        catch {
            throw new Error(`浏览器无法读取${descriptor.label}，请检查站点存储权限。`);
        }
        let value;
        try {
            value = raw === null ? descriptor.defaults() : descriptor.validate(JSON.parse(raw));
        }
        catch {
            throw new Error(`已保存的${descriptor.label}无法读取，原始记录已保留，未覆盖。`);
        }
        return { storage, raw, value };
    }
    function saveLocal(value) {
        const { storage, raw: previous } = localRecord();
        const raw = JSON.stringify(descriptor.validate(value));
        const restore = () => {
            if (storage.getItem(descriptor.localKey) !== raw)
                return;
            if (previous === null)
                storage.removeItem(descriptor.localKey);
            else
                storage.setItem(descriptor.localKey, previous);
        };
        try {
            storage.setItem(descriptor.localKey, raw);
            if (storage.getItem(descriptor.localKey) !== raw)
                throw new Error();
        }
        catch {
            try {
                restore();
            }
            catch { /* Preserve the original failure. */ }
            throw new Error(`${descriptor.label}未能保存，请检查浏览器存储权限或剩余空间。`);
        }
        return restore;
    }
    function forHost(value, includeKeys = syncApiKeys) {
        const snapshot = descriptor.validate(value);
        return descriptor.validate(!includeKeys && descriptor.stripKeys ? descriptor.stripKeys(snapshot) : snapshot);
    }
    function load() {
        if (!getHostStore())
            return localRecord().value;
        if (!initialized || cached === undefined)
            throw new Error(`${descriptor.label}尚未完成 TT 存储初始化。`);
        return descriptor.validate(cached);
    }
    async function commit(value) {
        if (getHostStore() && !initialized)
            throw new Error(`${descriptor.label}尚未完成 TT 存储初始化。`);
        const restoreLocal = saveLocal(value);
        if (getHostStore()) {
            const saved = forHost(value);
            try {
                await writeHostJson(descriptor.hostKey, saved);
            }
            catch {
                try {
                    restoreLocal();
                }
                catch { /* The native cache remains unchanged. */ }
                throw new Error(`${descriptor.label}未能写入 TT 存储，请重试。`);
            }
            cached = descriptor.validate(value);
            nativeValue = saved;
            exists = true;
        }
        try {
            descriptor.changed?.();
        }
        catch {
            console.warn(`[魔女画匣] ${descriptor.label}更新监听失败。`);
        }
    }
    participants.push({
        async initialize() {
            const saved = await readHostJson(descriptor.hostKey);
            if (saved.found) {
                nativeValue = descriptor.validate(saved.value);
                cached = descriptor.validate(!syncApiKeys && descriptor.restoreKeys
                    ? descriptor.restoreKeys(descriptor.validate(nativeValue), localRecord().value) : nativeValue);
                exists = true;
            }
            else {
                const local = localRecord();
                cached = descriptor.validate(local.value);
                exists = local.raw !== null;
                if (exists) {
                    nativeValue = forHost(cached);
                    await writeHostJson(descriptor.hostKey, nativeValue);
                }
            }
            initialized = true;
        },
        prepareKeySync(enabled) {
            if (!descriptor.stripKeys || !exists || cached === undefined || nativeValue === undefined)
                return null;
            const snapshot = descriptor.validate(cached);
            const previous = descriptor.validate(nativeValue);
            const next = forHost(snapshot, enabled);
            return {
                async write() {
                    // Retain keys received from another device before stripping the native copy.
                    saveLocal(snapshot);
                    await writeHostJson(descriptor.hostKey, next);
                    nativeValue = next;
                },
                async rollback() { await writeHostJson(descriptor.hostKey, previous); nativeValue = previous; },
            };
        },
    });
    return {
        load,
        hasSaved() { return getHostStore() ? exists : localRecord().raw !== null; },
        save(value) {
            const snapshot = descriptor.validate(value);
            return withHostLock(writeLock, () => commit(snapshot));
        },
        update(change) {
            return withHostLock(writeLock, () => commit(descriptor.validate(change(load()))));
        },
    };
}
