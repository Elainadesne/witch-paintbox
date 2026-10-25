/** TauriTavern's public extension store participates in its extensions.store sync dataset. */
export const HOST_NAMESPACE = 'witch-paintbox';
let store = null;
let detected = false;
const locks = new Map();
export async function initializeHostStorage() {
    const host = window;
    detected = !!host.__TAURITAVERN__ || host.__TAURI_RUNNING__ === true;
    if (!detected)
        return;
    await (host.__TAURITAVERN__?.ready ?? host.__TAURITAVERN_MAIN_READY__);
    const candidate = host.__TAURITAVERN__?.api?.extension?.store;
    if (candidate && ['tryGetJson', 'setJson', 'getBlob', 'setBlob', 'deleteBlob']
        .every(method => typeof candidate[method] === 'function'))
        store = candidate;
}
export function getHostStore() { return store; }
export function isTauriHost() { return detected; }
export function readHostJson(key, table = 'main') {
    if (!store)
        throw new Error('当前宿主不支持扩展数据存储。');
    return store.tryGetJson({ namespace: HOST_NAMESPACE, table, key });
}
export async function writeHostJson(key, value, table = 'main') {
    if (!store)
        throw new Error('当前宿主不支持扩展数据存储。');
    await store.setJson({ namespace: HOST_NAMESPACE, table, key, value: structuredClone(value) });
}
/** Keep read/modify/write operations in one domain ordered within this page. */
export function withHostLock(key, action) {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(action);
    locks.set(key, next);
    void next.finally(() => { if (locks.get(key) === next)
        locks.delete(key); }).catch(() => { });
    return next;
}
