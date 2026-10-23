export interface WorldbookSourceEntry {
  /** Stable UID within this worldbook; pair it with the book name when storing selections. */
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

interface WorldbookHost {
  getRequestHeaders(): HeadersInit;
}

class WorldbookSourceError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function host(): WorldbookHost {
  const root = globalThis as typeof globalThis & { SillyTavern?: { getContext(): unknown } };
  const context = root.SillyTavern?.getContext() as Partial<WorldbookHost> | undefined;
  if (!context || typeof context.getRequestHeaders !== 'function') {
    throw new WorldbookSourceError('当前环境未提供酒馆世界书连接。');
  }
  return context as WorldbookHost;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

async function withRead<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('读取已取消。', 'AbortError');
    if (timedOut) throw new WorldbookSourceError('读取世界书超时，请稍后重试。');
    if (error instanceof WorldbookSourceError) throw error;
    throw new WorldbookSourceError('读取世界书失败，请检查酒馆后端连接。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

async function post(path: 'worldinfo/list' | 'worldinfo/get' | 'settings/get', body: object, context: WorldbookHost, signal: AbortSignal): Promise<unknown> {
  const headers = new Headers(context.getRequestHeaders());
  headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new WorldbookSourceError(`读取世界书失败（HTTP ${response.status}）。`, response.status);
  try { return await response.json(); }
  catch { signal.throwIfAborted(); throw new WorldbookSourceError('酒馆返回的世界书数据无法解析。'); }
}

function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name.trim())) {
    throw new WorldbookSourceError('酒馆返回的世界书列表格式无效。');
  }
  return [...new Set(value as string[])].sort((a, b) => a.localeCompare(b));
}

async function listNames(context: WorldbookHost, signal: AbortSignal): Promise<string[]> {
  try {
    const data = await post('worldinfo/list', {}, context, signal);
    if (!Array.isArray(data)) throw new WorldbookSourceError('酒馆返回的世界书列表格式无效。');
    // Display names can differ from filenames. Only file_id is accepted by /get.
    return names(data.map(item => record(item)?.file_id));
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof WorldbookSourceError) || ![404, 405].includes(error.status ?? 0)) throw error;
  }
  // This is also the native updateWorldInfoList endpoint on older Tavern versions.
  // Read only its fresh filename list; do not invoke the editor-mutating native helper.
  return names(record(await post('settings/get', {}, context, signal))?.world_names);
}

/** Lists stored worldbook filenames without changing their host activation state. */
export async function listWorldbooks(signal?: AbortSignal): Promise<string[]> {
  return withRead(signal, requestSignal => listNames(host(), requestSignal));
}

function uid(value: unknown): string | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : null;
}

/** Reads literal nonempty content. Selection and prompt placement belong to the caller. */
export async function readWorldbook(name: string, signal?: AbortSignal): Promise<WorldbookSourceEntry[]> {
  return withRead(signal, async requestSignal => {
    if (typeof name !== 'string' || !name.trim()) throw new WorldbookSourceError('请先选择世界书。');
    const context = host();
    // /get returns { entries: {} } even for missing files; check existence first.
    if (!(await listNames(context, requestSignal)).includes(name)) {
      throw new WorldbookSourceError(`世界书“${name}”不存在，可能已被删除或改名，请刷新列表。`);
    }
    const data = record(await post('worldinfo/get', { name }, context, requestSignal));
    const entries = record(data?.entries);
    if (!entries) throw new WorldbookSourceError(`世界书“${name}”的条目格式无效。`);
    if (!Object.keys(entries).length && !(await listNames(context, requestSignal)).includes(name)) {
      throw new WorldbookSourceError(`世界书“${name}”已被删除或改名，请刷新列表。`);
    }
    const seen = new Set<string>();
    const result: WorldbookSourceEntry[] = [];
    for (const [key, value] of Object.entries(entries)) {
      const entry = record(value);
      const id = uid(entry?.uid ?? key);
      if (!entry || id === null || uid(key) !== id || seen.has(id)) {
        throw new WorldbookSourceError(`世界书“${name}”有无效或重复的条目标识，无法可靠读取。`);
      }
      seen.add(id);
      if (typeof entry.content !== 'string' || (entry.disable !== undefined && typeof entry.disable !== 'boolean')) {
        throw new WorldbookSourceError(`世界书“${name}”的条目 ${id} 格式无效。`);
      }
      if (!entry.content.trim()) continue;
      const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
      result.push({ id, name: comment || `条目 ${id}`, content: entry.content, enabled: !entry.disable });
    }
    requestSignal.throwIfAborted();
    return result;
  });
}
