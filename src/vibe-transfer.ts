import { ImageResponseError } from './image-response.js';
import type { ImageConnection } from './novelai.js';
import { getHostStore, HOST_NAMESPACE, readHostJson, withHostLock, writeHostJson } from './host-storage.js';

/**
 * NAI Vibe Transfer: reference images kept on this device.
 * V4 / V4.5 need a model-bound encoding from /ai/encode-vibe (2 Anlas each); V3 takes the raw image.
 * Encodings are cached per item (= image hash) by model and information-extracted value.
 */
export const VIBE_LIMIT = 16;
export const VIBE_FREE_COUNT = 4;
export const VIBE_IMAGE_LIMIT = 8 * 1024 * 1024;

const SHORT_NAMES: Record<string, string> = {
  'nai-diffusion-4-5-full': 'v4-5full',
  'nai-diffusion-4-5-curated': 'v4-5curated',
  'nai-diffusion-4-full': 'v4full',
  'nai-diffusion-4-curated-preview': 'v4curated',
};
const LONG_NAMES = Object.fromEntries(Object.entries(SHORT_NAMES).map(([long, short]) => [short, long]));

export type VibeSupport = 'encoded' | 'raw' | 'unavailable';
/** V5 has not shipped Vibe Transfer yet; requests with it return HTTP 500. */
export function vibeSupport(model: string): VibeSupport {
  if (SHORT_NAMES[model]) return 'encoded';
  if (model === 'nai-diffusion-3') return 'raw';
  return 'unavailable';
}

export interface VibeItem {
  id: string;
  name: string;
  enabled: boolean;
  /** Reference strength, 0.01–1; changing it never needs re-encoding. */
  strength: number;
  /** Information extracted, 0.01–1; part of the encoding cache key. */
  informationExtracted: number;
  /** Original picture; files imported without one can only use their bundled encodings. */
  image: Blob | null;
  thumbnail: Blob | null;
  /** SHA-256 of the original picture, or of the imported file when no picture exists. */
  hash: string;
  /** model short name -> information_extracted (2 decimals) -> encoding base64 */
  encodings: Record<string, Record<string, string>>;
  createdAt: number;
}

export interface VibeState {
  normalize: boolean;
  items: VibeItem[];
}

function fail(message: string, fault: 'setup' | 'auth' | 'quota' | 'busy' | 'network' | 'unknown' = 'setup'): never {
  throw new ImageResponseError(message, fault);
}

export const ieKey = (value: number): string => clampUnit(value).toFixed(2);
export function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0.01, Math.round(value * 100) / 100)) : 1;
}

// ── base64 helpers ──
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(bytes);
}
export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
export function base64ToBlob(value: string, type = 'image/png'): Blob {
  const clean = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const text = atob(clean);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return new Blob([bytes], { type });
}
async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function newId(): string {
  return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

// ── IndexedDB ──
const databaseName = 'witch-paintbox-vibes';
let connection: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = window.indexedDB.open(databaseName, 1); }
    catch { reject(new Error('浏览器打不开氛围参考库，看看是不是站点存储权限被拦住了。')); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    request.onblocked = () => reject(new Error('氛围参考库正被别的页面占着，关掉多余的酒馆页再试试。'));
    request.onerror = () => reject(new Error('浏览器没打开氛围参考库，查一下存储权限或硬盘还够不够地方。'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); if (connection === pending) connection = null; };
      resolve(db);
    };
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = null; });
  return pending;
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error('氛围参考没存进去，八成是浏览器存储空间不够了。'));
  });
}

const listeners = new Set<() => void>();
export function onVibesChanged(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function changed(): void { for (const listener of listeners) { try { listener(); } catch { /* View errors stay local. */ } } }

async function localState(): Promise<VibeState> {
  const db = await database();
  const transaction = db.transaction(['items', 'meta'], 'readonly');
  const items = transaction.objectStore('items').getAll();
  const normalize = transaction.objectStore('meta').get('normalize');
  await done(transaction);
  return { normalize: normalize.result === undefined ? true : Boolean(normalize.result), items: items.result as VibeItem[] };
}

// ── TauriTavern extension data: manifest JSON + content-addressed picture blobs ──
const hostTable = 'vibes';
const hostLock = 'vibes';
type NativeVibe = Omit<VibeItem, 'image' | 'thumbnail'> & { imageKey: string | null; thumbnailKey: string | null };
interface NativeManifest { version: 1; normalize: boolean; items: NativeVibe[] }

function pictureExtension(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if ([137, 80, 78, 71].every((byte, index) => bytes[index] === byte)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if ([82, 73, 70, 70].every((byte, index) => bytes[index] === byte) && [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte)) return 'webp';
  return null;
}
async function putPicture(blob: Blob | null, prefix: string): Promise<string | null> {
  if (!blob) return null;
  const buffer = await blob.arrayBuffer();
  const extension = pictureExtension(new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength)));
  if (!extension) fail('氛围参考只认 PNG、JPEG 或 WebP 格式的图片。');
  // Same picture, same key: metadata edits never duplicate blobs.
  const key = `${prefix}-${await sha256(buffer)}.${extension}`;
  await getHostStore()!.setBlob({ namespace: HOST_NAMESPACE, table: hostTable, key, data: blob });
  return key;
}
async function getPicture(key: string | null, name: string): Promise<Blob | null> {
  if (!key) return null;
  try {
    const blob = await getHostStore()!.getBlob({ namespace: HOST_NAMESPACE, table: hostTable, key });
    const type = key.endsWith('.jpg') ? 'image/jpeg' : key.endsWith('.webp') ? 'image/webp' : 'image/png';
    return blob.slice(0, blob.size, type);
  } catch { throw new Error(`氛围图“${name}”的图片还在同步呢，等同步完了再试。`); }
}
async function toNative(item: VibeItem): Promise<NativeVibe> {
  const { image, thumbnail, ...fields } = item;
  return { ...fields, strength: clampUnit(fields.strength), informationExtracted: clampUnit(fields.informationExtracted),
    imageKey: await putPicture(image, 'vibe'), thumbnailKey: await putPicture(thumbnail, 'thumb') };
}
/** An existing native manifest (even empty) wins; otherwise this device's IndexedDB library is migrated once. */
async function nativeManifest(): Promise<NativeManifest> {
  const stored = await readHostJson('manifest', hostTable);
  if (!stored.found) {
    const old = await localState();
    const manifest: NativeManifest = { version: 1, normalize: old.normalize, items: [] };
    for (const item of old.items) manifest.items.push(await toNative(item));
    await writeHostJson('manifest', manifest, hostTable);
    return manifest;
  }
  const value = stored.value as Partial<NativeManifest> | null;
  if (!value || value.version !== 1 || !Array.isArray(value.items)) fail('同步过来的氛围参考格式不对，没盖掉本机记录，先去看看同步状态吧。');
  const keyPattern = /^(?:vibe|thumb)-[a-f0-9]{64}\.(?:png|jpg|webp)$/;
  for (const item of value.items) {
    if (!item || typeof item.id !== 'string' || typeof item.hash !== 'string'
      || [item.imageKey, item.thumbnailKey].some(key => key !== null && (typeof key !== 'string' || !keyPattern.test(key)))) {
      fail('同步过来的氛围参考有一条格式不对，看看同步状态。');
    }
  }
  return { version: 1, normalize: value.normalize !== false, items: value.items };
}
function hostWrite(update: (manifest: NativeManifest) => Promise<void> | void): Promise<void> {
  return withHostLock(hostLock, async () => {
    const manifest = await nativeManifest();
    await update(manifest);
    // Pictures are written first; the manifest only references blobs that already exist.
    await writeHostJson('manifest', manifest, hostTable);
  });
}

export async function loadVibes(): Promise<VibeState> {
  let state: VibeState;
  if (getHostStore()) {
    state = await withHostLock(hostLock, async () => {
      const manifest = await nativeManifest();
      const items: VibeItem[] = [];
      for (const { imageKey, thumbnailKey, ...fields } of manifest.items) {
        items.push({ ...fields, image: await getPicture(imageKey, fields.name), thumbnail: await getPicture(thumbnailKey, fields.name) });
      }
      return { normalize: manifest.normalize, items };
    });
  } else state = await localState();
  state.items.sort((a, b) => a.createdAt - b.createdAt);
  return state;
}

export async function saveVibe(item: VibeItem): Promise<void> {
  if (getHostStore()) {
    await hostWrite(async manifest => {
      const native = await toNative(item);
      const index = manifest.items.findIndex(entry => entry.id === item.id);
      if (index >= 0) manifest.items[index] = native; else manifest.items.push(native);
    });
  } else {
    const db = await database();
    const transaction = db.transaction('items', 'readwrite');
    transaction.objectStore('items').put({ ...item, strength: clampUnit(item.strength), informationExtracted: clampUnit(item.informationExtracted) });
    await done(transaction);
  }
  changed();
}
export async function deleteVibe(id: string): Promise<void> {
  if (getHostStore()) {
    // Blobs stay behind for in-flight sync readers, same as character portraits.
    await hostWrite(manifest => { manifest.items = manifest.items.filter(entry => entry.id !== id); });
  } else {
    const db = await database();
    const transaction = db.transaction('items', 'readwrite');
    transaction.objectStore('items').delete(id);
    await done(transaction);
  }
  changed();
}
export async function saveVibeNormalize(value: boolean): Promise<void> {
  if (getHostStore()) await hostWrite(manifest => { manifest.normalize = value; });
  else {
    const db = await database();
    const transaction = db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put(value, 'normalize');
    await done(transaction);
  }
  changed();
}

// ── Adding pictures and .naiv4vibe files ──
export async function vibeFromImage(file: Blob, name: string): Promise<VibeItem> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) fail('氛围参考只认 PNG、JPEG 或 WebP 图片。');
  if (!file.size || file.size > VIBE_IMAGE_LIMIT) fail('氛围参考图太大了，得在 8 MiB 以内。');
  const hash = await sha256(await file.arrayBuffer());
  return {
    id: newId(), name: name.replace(/\.[^.]+$/, '').slice(0, 120) || '氛围图', enabled: true,
    strength: 0.6, informationExtracted: 1, image: file, thumbnail: null, hash, encodings: {}, createdAt: Date.now(),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampUnit(value) : fallback;
}

async function vibeFromJson(source: Record<string, unknown>, offset: number): Promise<VibeItem> {
  if (source.identifier !== 'novelai-vibe-transfer') fail('这个文件看着不是正经的 NovelAI 氛围参考（.naiv4vibe）。');
  const encodings: VibeItem['encodings'] = {};
  for (const [model, entries] of Object.entries(record(source.encodings))) {
    if (!LONG_NAMES[model]) continue;
    for (const entry of Object.values(record(entries))) {
      const value = record(entry);
      if (typeof value.encoding !== 'string' || !value.encoding) continue;
      const ie = unit(record(value.params).information_extracted, 1);
      (encodings[model] ??= {})[ieKey(ie)] = value.encoding;
    }
  }
  const imageText = typeof source.image === 'string' && source.image ? source.image : '';
  const thumbText = typeof source.thumbnail === 'string' && source.thumbnail ? source.thumbnail : '';
  const toBlob = (text: string) => {
    try { return base64ToBlob(text, /^data:image\/jpeg/.test(text) ? 'image/jpeg' : /^data:image\/webp/.test(text) ? 'image/webp' : 'image/png'); }
    catch { return null; }
  };
  const image = imageText ? toBlob(imageText) : null;
  const thumbnail = thumbText ? toBlob(thumbText) : null;
  if (!image && !Object.keys(encodings).length) fail('这个氛围参考文件里既没带原图，也没有现成编码。');
  if (image && image.size > VIBE_IMAGE_LIMIT) fail('氛围参考里的原图太大了，得小于 8 MiB。');
  const info = record(source.importInfo);
  const hash = image ? await sha256(await image.arrayBuffer()) : await sha256(new TextEncoder().encode(JSON.stringify(encodings)));
  return {
    id: newId(), name: (typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '导入的氛围图').slice(0, 120),
    enabled: true, strength: unit(info.strength, 0.6), informationExtracted: unit(info.information_extracted, 1),
    image, thumbnail, hash, encodings, createdAt: Date.now() + offset,
  };
}

/** Accepts a single .naiv4vibe or a .naiv4vibeBundle. */
export async function vibesFromFile(text: string): Promise<VibeItem[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('这个氛围文件不是合法的 JSON，是不是下坏了？'); }
  const source = record(parsed);
  if (source.identifier === 'novelai-vibe-transfer-bundle' || Array.isArray(source.vibes)) {
    const vibes = Array.isArray(source.vibes) ? source.vibes : [];
    if (!vibes.length) fail('这个氛围参考合集里是空的，一张图也没有。');
    if (vibes.length > VIBE_LIMIT) fail(`合集里的图超过了 ${VIBE_LIMIT} 张上限，装不下。`);
    return Promise.all(vibes.map((vibe, index) => vibeFromJson(record(vibe), index)));
  }
  return [await vibeFromJson(source, 0)];
}

function vibeJson(item: VibeItem, image: string, thumbnail: string): Record<string, unknown> {
  const encodings: Record<string, Record<string, unknown>> = {};
  for (const [model, values] of Object.entries(item.encodings)) {
    for (const [ie, encoding] of Object.entries(values)) {
      (encodings[model] ??= {})[`${item.hash.slice(0, 16)}-${ie}`] = { encoding, params: { information_extracted: Number(ie) } };
    }
  }
  const model = Object.keys(item.encodings)[0];
  return {
    identifier: 'novelai-vibe-transfer', version: 1, type: image ? 'image' : 'encoding', id: item.hash,
    image, thumbnail, name: item.name, encodings, createdAt: item.createdAt,
    importInfo: { model: model ? LONG_NAMES[model] : 'nai-diffusion-4-5-full', information_extracted: item.informationExtracted, strength: item.strength },
  };
}

export async function exportVibeBundle(items: readonly VibeItem[]): Promise<Blob> {
  const vibes = [];
  for (const item of items) {
    vibes.push(vibeJson(item, item.image ? await blobToBase64(item.image) : '', item.thumbnail ? await blobToBase64(item.thumbnail) : ''));
  }
  return new Blob([JSON.stringify({ identifier: 'novelai-vibe-transfer-bundle', version: 1, vibes })], { type: 'application/json' });
}

// ── Encoding and request fields ──
export function encodeEndpoint(connection: ImageConnection): string {
  if (connection.channel === 'official') return 'https://image.novelai.net/ai/encode-vibe';
  let url: URL;
  try { url = new URL(connection.url.trim()); } catch { return fail('把自定义接口地址填完整再来。'); }
  const path = url.pathname.replace(/\/+$/, '');
  if (connection.appendSuffix) {
    url.pathname = `${path.replace(/\/ai\/generate-image$/, '')}/ai/encode-vibe`;
    return url.href;
  }
  if (!path.endsWith('/ai/generate-image')) {
    fail('这个自定义地址不是以 /ai/generate-image 结尾，画匣推不出该往哪发编码请求。把“自动拼接接口后缀”打开，或者直接导入带现成编码的 .naiv4vibe 文件吧。');
  }
  url.pathname = path.replace(/\/ai\/generate-image$/, '/ai/encode-vibe');
  return url.href;
}

export async function encodeVibe(connection: ImageConnection, image: Blob, model: string, informationExtracted: number, signal: AbortSignal): Promise<string> {
  const key = connection.key.trim().replace(/^Bearer\s+/i, '');
  if (!key) fail('先把 API 密钥填上。');
  const body = JSON.stringify({ image: await blobToBase64(image), model, information_extracted: clampUnit(informationExtracted) });
  let response: Response;
  try {
    response = await fetch(encodeEndpoint(connection), {
      method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return fail('氛围编码请求中途断了，查查网络、跨域，或者反代有没有顺带转发 /ai/encode-vibe。', 'network');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) fail('氛围编码被拒了：密钥不对或者没权限。', 'auth');
    if (response.status === 402) fail('氛围编码失败：Anlas 点数不够啦（每张要 2 Anlas）。', 'quota');
    if (response.status === 429) fail('编码请求发太密了，等两秒再试。', 'busy');
    fail(`氛围编码没过（HTTP ${response.status}），也可能是你选的模型还不支持氛围参考。`, 'unknown');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) fail('编码接口回了个空包，没拿到编码。', 'unknown');
  return bytesToBase64(bytes);
}

export interface VibeReferences {
  images: string[];
  strengths: number[];
  informationExtracted: number[];
  normalize: boolean;
  /** How many /ai/encode-vibe calls this request made (2 Anlas each). */
  encoded: number;
}

/**
 * Build request fields for the enabled vibes. Missing encodings are fetched once and cached;
 * returns null when nothing is enabled or the model cannot take vibes (V5 is skipped silently).
 */
export async function prepareVibeReferences(connection: ImageConnection, model: string, signal: AbortSignal): Promise<VibeReferences | null> {
  const support = vibeSupport(model);
  if (support === 'unavailable') return null;
  let state: VibeState;
  try { state = await loadVibes(); } catch { return null; }
  const enabled = state.items.filter(item => item.enabled);
  if (!enabled.length) return null;
  if (enabled.length > VIBE_LIMIT) fail(`一次最多只能同时启用 ${VIBE_LIMIT} 张氛围图。`);
  const result: VibeReferences = { images: [], strengths: [], informationExtracted: [], normalize: state.normalize, encoded: 0 };
  const short = SHORT_NAMES[model];
  for (const item of enabled) {
    signal.throwIfAborted();
    const ie = clampUnit(item.informationExtracted);
    if (support === 'raw') {
      if (!item.image) fail(`氛围图“${item.name}”只有编码没带原图，偏偏 V3 得用原图；换张有原图的或者切到 V4 / V4.5 吧。`);
      result.images.push(await blobToBase64(item.image));
    } else {
      let encoding = item.encodings[short]?.[ieKey(ie)];
      if (!encoding) {
        if (!item.image) {
          const have = Object.keys(item.encodings).map(name => LONG_NAMES[name] ?? name).join('、') || '无';
          fail(`氛围图“${item.name}”没有原图，手头又缺当前模型、提取度 ${ieKey(ie)} 的编码（目前只存了：${have}）。换回原来的模型或提取度就能用了。`);
        }
        encoding = await encodeVibe(connection, item.image, model, ie, signal);
        result.encoded++;
        const next = { ...item, encodings: { ...item.encodings, [short]: { ...item.encodings[short], [ieKey(ie)]: encoding } } };
        try { await saveVibe(next); } catch { /* The request can still use it; only the cache is lost. */ }
      }
      result.images.push(encoding);
    }
    result.strengths.push(clampUnit(item.strength));
    result.informationExtracted.push(ie);
  }
  return result;
}

/** Whether an item would need a paid encoding for this model at its current settings. */
export function needsEncoding(item: VibeItem, model: string): boolean {
  const short = SHORT_NAMES[model];
  return Boolean(short) && !item.encodings[short]?.[ieKey(item.informationExtracted)];
}
