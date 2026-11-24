import { getHostStore, readHostJson, withHostLock, writeHostJson } from './host-storage.js';

interface SettingsDescriptor<T> {
  localKey: string;
  hostKey: string;
  label: string;
  defaults(): T;
  validate(value: unknown): T;
  stripKeys?(value: T): T;
  restoreKeys?(value: T, local: T): T;
  changed?(): void;
}

interface SettingsParticipant {
  initialize(): Promise<void>;
  prepareKeySync(enabled: boolean): { write(): Promise<void>; rollback(): Promise<void> } | null;
}

const participants: SettingsParticipant[] = [];
const writeLock = 'settings';
let syncApiKeys = false;
let ready = false;

export function getSyncApiKeys(): boolean { return !!getHostStore() && syncApiKeys; }

export async function initializeSettingsStorage(): Promise<void> {
  // Load every domain before restoring its synchronous read cache.
  await Promise.all([import('./image-settings.js'), import('./model-settings.js'), import('./shared-outfit-store.js')]);
  if (!getHostStore()) { ready = true; return; }
  const options = await readHostJson('sync-options-v1');
  if (options.found) {
    const value = options.value as { includeApiKeys?: unknown } | null;
    if (!value || typeof value !== 'object' || typeof value.includeApiKeys !== 'boolean') {
      throw new Error('TT 同步开关那项的格式不对，原来的记录没动。');
    }
    syncApiKeys = value.includeApiKeys;
  }
  for (const participant of participants) await participant.initialize();
  ready = true;
}

export async function setSyncApiKeys(enabled: boolean): Promise<void> {
  if (!getHostStore() || !ready) throw new Error('酒馆这边的配置同步还没准备好。');
  await withHostLock(writeLock, async () => {
    if (enabled === syncApiKeys) return;
    const operations = participants.map(item => item.prepareKeySync(enabled)).filter(item => item !== null);
    const attempted: typeof operations = [];
    try {
      for (const operation of operations) {
        attempted.push(operation);
        await operation.write();
      }
      await writeHostJson('sync-options-v1', { includeApiKeys: enabled });
      syncApiKeys = enabled;
    } catch {
      let restored = true;
      try { await writeHostJson('sync-options-v1', { includeApiKeys: syncApiKeys }); }
      catch { restored = false; }
      for (const operation of attempted.reverse()) {
        try { await operation.rollback(); } catch { restored = false; }
      }
      throw new Error(`密钥同步开关没存上。${restored ? '原本的设置好好的没变。' : '有几项原生配置没来得及回滚，等会儿重设一下再同步。'}`);
    }
  });
}

/** Keep browser storage as the local key copy; TT owns the synchronized snapshot. */
export function createSettingsStorage<T>(descriptor: SettingsDescriptor<T>) {
  let cached: T | undefined;
  let nativeValue: T | undefined;
  let initialized = false;
  let exists = false;

  function localRecord(): { storage: Storage; raw: string | null; value: T } {
    let storage: Storage, raw: string | null;
    try { storage = window.localStorage; raw = storage.getItem(descriptor.localKey); }
    catch { throw new Error(`浏览器读不到${descriptor.label}，看看是不是站点存储权限被拦住了。`); }
    let value: T;
    try { value = raw === null ? descriptor.defaults() : descriptor.validate(JSON.parse(raw)); }
    catch { throw new Error(`之前存着的${descriptor.label}这会儿读不出来，放心原始记录没被覆盖掉。`); }
    return { storage, raw, value };
  }

  function saveLocal(value: T): () => void {
    const { storage, raw: previous } = localRecord();
    const raw = JSON.stringify(descriptor.validate(value));
    const restore = () => {
      if (storage.getItem(descriptor.localKey) !== raw) return;
      if (previous === null) storage.removeItem(descriptor.localKey);
      else storage.setItem(descriptor.localKey, previous);
    };
    try {
      storage.setItem(descriptor.localKey, raw);
      if (storage.getItem(descriptor.localKey) !== raw) throw new Error();
    } catch {
      try { restore(); } catch { /* Preserve the original failure. */ }
      throw new Error(`${descriptor.label}没存上，查一下浏览器存储权限或者空间够不够。`);
    }
    return restore;
  }

  function forHost(value: T, includeKeys = syncApiKeys): T {
    const snapshot = descriptor.validate(value);
    return descriptor.validate(!includeKeys && descriptor.stripKeys ? descriptor.stripKeys(snapshot) : snapshot);
  }

  function load(): T {
    if (!getHostStore()) return localRecord().value;
    if (!initialized || cached === undefined) throw new Error(`${descriptor.label}还在初始化 TT 存储，等它跑完。`);
    return descriptor.validate(cached);
  }

  async function commit(value: T): Promise<void> {
    if (getHostStore() && !initialized) throw new Error(`${descriptor.label}还在初始化 TT 存储，等它跑完。`);
    const restoreLocal = saveLocal(value);
    if (getHostStore()) {
      const saved = forHost(value);
      try { await writeHostJson(descriptor.hostKey, saved); }
      catch {
        try { restoreLocal(); } catch { /* The native cache remains unchanged. */ }
        throw new Error(`${descriptor.label}没写进 TT 存储里，再试一次。`);
      }
      cached = descriptor.validate(value);
      nativeValue = saved;
      exists = true;
    }
    try { descriptor.changed?.(); }
    catch { console.warn(`[魔女画匣] ${descriptor.label}更新监听失败。`); }
  }

  participants.push({
    async initialize() {
      const saved = await readHostJson(descriptor.hostKey);
      if (saved.found) {
        nativeValue = descriptor.validate(saved.value);
        cached = descriptor.validate(!syncApiKeys && descriptor.restoreKeys
          ? descriptor.restoreKeys(descriptor.validate(nativeValue), localRecord().value) : nativeValue);
        exists = true;
      } else {
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
      if (!descriptor.stripKeys || !exists || cached === undefined || nativeValue === undefined) return null;
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
    hasSaved(): boolean { return getHostStore() ? exists : localRecord().raw !== null; },
    save(value: T): Promise<void> {
      const snapshot = descriptor.validate(value);
      return withHostLock(writeLock, () => commit(snapshot));
    },
    update(change: (value: T) => T): Promise<void> {
      return withHostLock(writeLock, () => commit(descriptor.validate(change(load()))));
    },
  };
}
