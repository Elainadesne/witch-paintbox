import type { ImageParameters } from './novelai.js';

export interface ImageHistoryEntry {
  id: string;
  markerKey: string;
  blob: Blob;
  createdAt: number;
  parameters: ImageParameters;
  positive: string;
  negative: string;
  seed: number;
  /** Original scene tags before anchor expansion and artist additions. Older entries omit this. */
  scenePrompt?: string;
}

const databaseName = 'witch-paintbox-image-history';
const storeName = 'images';
let connection: Promise<IDBDatabase> | null = null;
const changeListeners = new Set<() => void>();

export function onImageHistoryChanged(callback: () => void): () => void {
  changeListeners.add(callback);
  return () => { changeListeners.delete(callback); };
}

function notifyChanged(): void {
  for (const listener of changeListeners) {
    try { listener(); } catch { /* View failures must not undo committed image history. */ }
  }
}

function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail('打开图片历史超时，请关闭其他酒馆页面后重试。'), 15_000);
    function fail(message: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    }
    let request: IDBOpenDBRequest;
    try { request = window.indexedDB.open(databaseName, 1); }
    catch { fail('浏览器无法打开图片历史，请检查站点存储权限。'); return; }
    request.onblocked = () => fail('图片历史被其他页面占用，请关闭其他酒馆页面后重试。');
    request.onerror = () => fail('浏览器未能打开图片历史，请检查存储权限或剩余空间。');
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      try {
        const db = request.result;
        const store = db.objectStoreNames.contains(storeName)
          ? request.transaction!.objectStore(storeName)
          : db.createObjectStore(storeName, { keyPath: 'id' });
        if (!store.indexNames.contains('markerKey')) store.createIndex('markerKey', 'markerKey', { unique: false });
      } catch {
        request.transaction?.abort();
        fail('图片历史存储初始化失败。');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      const invalidate = () => { if (connection === pending) connection = null; };
      db.onversionchange = () => { invalidate(); db.close(); };
      db.onclose = invalidate;
      resolve(db);
    };
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = null; });
  return pending;
}

function operationError(action: string, error?: DOMException | null): Error {
  return new Error(error?.name === 'QuotaExceededError'
    ? `图片历史${action}失败，浏览器存储空间不足。`
    : `图片历史${action}失败，请检查站点存储权限后重试。`);
}

async function transact<T>(mode: IDBTransactionMode, action: string, makeRequest: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction(storeName, mode); }
    catch { connection = null; db.close(); reject(operationError(action)); return; }
    let settled = false;
    const timer = setTimeout(() => {
      try { transaction.abort(); } catch { /* The transaction may already be finishing. */ }
      fail(new Error(`图片历史${action}超时，尚未确认完成，请重试。`));
    }, 30_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    let request: IDBRequest<T>;
    transaction.onabort = () => fail(operationError(action, transaction.error));
    transaction.onerror = () => fail(operationError(action, transaction.error));
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    try {
      request = makeRequest(transaction.objectStore(storeName));
      request.onerror = () => fail(operationError(action, request.error));
    }
    catch {
      try { transaction.abort(); } catch { /* Failure is reported below. */ }
      fail(operationError(action));
    }
  });
}

function snapshot(value: unknown): ImageHistoryEntry {
  const entry = value as ImageHistoryEntry | null;
  const parameters = entry?.parameters;
  if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.markerKey !== 'string' || !entry.markerKey
    || !(entry.blob instanceof Blob) || !entry.blob.size
    || !Number.isFinite(entry.createdAt) || entry.createdAt < 0
    || !Number.isInteger(entry.seed) || entry.seed < 0 || entry.seed > 4_294_967_295
    || typeof entry.positive !== 'string' || typeof entry.negative !== 'string'
    || (entry.scenePrompt !== undefined && typeof entry.scenePrompt !== 'string')
    || !parameters || typeof parameters.model !== 'string' || typeof parameters.sampler !== 'string'
    || typeof parameters.noiseSchedule !== 'string' || typeof parameters.sm !== 'boolean' || typeof parameters.smDyn !== 'boolean'
    || ![parameters.width, parameters.height, parameters.steps, parameters.scale, parameters.cfgRescale].every(Number.isFinite)) {
    throw new Error('图片历史记录格式无效，原有记录未修改。');
  }
  // Copy only image metadata: connection credentials and arbitrary extra fields never enter this store.
  return {
    id: entry.id, markerKey: entry.markerKey, blob: entry.blob, createdAt: entry.createdAt,
    parameters: {
      model: parameters.model, width: parameters.width, height: parameters.height,
      steps: parameters.steps, scale: parameters.scale, sampler: parameters.sampler,
      seed: entry.seed, noiseSchedule: parameters.noiseSchedule, cfgRescale: parameters.cfgRescale,
      sm: parameters.sm, smDyn: parameters.smDyn,
    },
    positive: entry.positive, negative: entry.negative, seed: entry.seed,
    ...(entry.scenePrompt === undefined ? {} : { scenePrompt: entry.scenePrompt }),
  };
}

export async function loadImageHistory(markerKey: string): Promise<ImageHistoryEntry[]> {
  if (typeof markerKey !== 'string' || !markerKey) throw new Error('图片标记标识无效，无法读取历史。');
  const entries = await transact('readonly', '读取', store => store.index('markerKey').getAll(markerKey));
  return entries.map(snapshot).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function saveImageHistory(entry: ImageHistoryEntry): Promise<void> {
  const saved = snapshot(entry);
  await transact('readwrite', '保存', store => store.put(saved));
  notifyChanged();
}

export async function deleteImageHistory(id: string): Promise<void> {
  if (typeof id !== 'string' || !id) throw new Error('图片历史标识无效，无法删除。');
  await transact('readwrite', '删除', store => store.delete(id));
  notifyChanged();
}
