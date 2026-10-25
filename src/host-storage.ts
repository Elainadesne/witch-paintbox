/** TauriTavern's public extension store participates in its extensions.store sync dataset. */
export const HOST_NAMESPACE = 'witch-paintbox';

interface JsonAddress { namespace: string; key: string; table?: string }
export interface HostStore {
  tryGetJson(address: JsonAddress): Promise<{ found: boolean; value?: unknown }>;
  setJson(address: JsonAddress & { value: unknown }): Promise<void>;
  getBlob(address: JsonAddress): Promise<Blob>;
  setBlob(address: JsonAddress & { data: Blob }): Promise<void>;
  deleteBlob(address: JsonAddress): Promise<void>;
}

let store: HostStore | null = null;
let detected = false;
const locks = new Map<string, Promise<unknown>>();

export async function initializeHostStorage(): Promise<void> {
  const host = window as Window & {
    __TAURITAVERN__?: { ready?: Promise<void>; api?: { extension?: { store?: HostStore } } };
    __TAURITAVERN_MAIN_READY__?: Promise<void>;
    __TAURI_RUNNING__?: boolean;
  };
  detected = !!host.__TAURITAVERN__ || host.__TAURI_RUNNING__ === true;
  if (!detected) return;
  await (host.__TAURITAVERN__?.ready ?? host.__TAURITAVERN_MAIN_READY__);
  const candidate = host.__TAURITAVERN__?.api?.extension?.store;
  if (candidate && ['tryGetJson', 'setJson', 'getBlob', 'setBlob', 'deleteBlob']
    .every(method => typeof candidate[method as keyof HostStore] === 'function')) store = candidate;
}

export function getHostStore(): HostStore | null { return store; }
export function isTauriHost(): boolean { return detected; }

export function readHostJson(key: string, table = 'main'): Promise<{ found: boolean; value?: unknown }> {
  if (!store) throw new Error('当前宿主不支持扩展数据存储。');
  return store.tryGetJson({ namespace: HOST_NAMESPACE, table, key });
}

export async function writeHostJson(key: string, value: unknown, table = 'main'): Promise<void> {
  if (!store) throw new Error('当前宿主不支持扩展数据存储。');
  await store.setJson({ namespace: HOST_NAMESPACE, table, key, value: structuredClone(value) });
}

/** Keep read/modify/write operations in one domain ordered within this page. */
export function withHostLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
