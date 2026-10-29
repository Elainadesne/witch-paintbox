import { ImageResponseError } from './image-response.js';
import { getHostStore, HOST_NAMESPACE, readHostJson, withHostLock, writeHostJson } from './host-storage.js';
/**
 * NAI Vibe Transfer: reference images kept on this device.
 * V4 / V4.5 need a model-bound encoding from /ai/encode-vibe (2 Anlas each); V3 takes the raw image.
 * Encodings are cached per item (= image hash) by model and information-extracted value.
 */
export const VIBE_LIMIT = 16;
export const VIBE_FREE_COUNT = 4;
export const VIBE_IMAGE_LIMIT = 8 * 1024 * 1024;
const SHORT_NAMES = {
    'nai-diffusion-4-5-full': 'v4-5full',
    'nai-diffusion-4-5-curated': 'v4-5curated',
    'nai-diffusion-4-full': 'v4full',
    'nai-diffusion-4-curated-preview': 'v4curated',
};
const LONG_NAMES = Object.fromEntries(Object.entries(SHORT_NAMES).map(([long, short]) => [short, long]));
/** V5 has not shipped Vibe Transfer yet; requests with it return HTTP 500. */
export function vibeSupport(model) {
    if (SHORT_NAMES[model])
        return 'encoded';
    if (model === 'nai-diffusion-3')
        return 'raw';
    return 'unavailable';
}
function fail(message, fault = 'setup') {
    throw new ImageResponseError(message, fault);
}
export const ieKey = (value) => clampUnit(value).toFixed(2);
export function clampUnit(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0.01, Math.round(value * 100) / 100)) : 1;
}
// ── base64 helpers ──
export async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return bytesToBase64(bytes);
}
export function bytesToBase64(bytes) {
    let text = '';
    for (let index = 0; index < bytes.length; index += 0x8000)
        text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
}
export function base64ToBlob(value, type = 'image/png') {
    const clean = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const text = atob(clean);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++)
        bytes[index] = text.charCodeAt(index);
    return new Blob([bytes], { type });
}
async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function newId() {
    return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
// ── IndexedDB ──
const databaseName = 'witch-paintbox-vibes';
let connection = null;
function database() {
    if (connection)
        return connection;
    const pending = new Promise((resolve, reject) => {
        let request;
        try {
            request = window.indexedDB.open(databaseName, 1);
        }
        catch {
            reject(new Error('浏览器无法打开氛围参考存储，请检查站点存储权限。'));
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('items'))
                db.createObjectStore('items', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('meta'))
                db.createObjectStore('meta');
        };
        request.onblocked = () => reject(new Error('氛围参考存储被其他页面占用，请关闭其他酒馆页面后重试。'));
        request.onerror = () => reject(new Error('浏览器未能打开氛围参考存储，请检查存储权限或剩余空间。'));
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); if (connection === pending)
                connection = null; };
            resolve(db);
        };
    });
    connection = pending;
    void pending.catch(() => { if (connection === pending)
        connection = null; });
    return pending;
}
function done(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(new Error('氛围参考保存失败，可能是存储空间不足。'));
    });
}
const listeners = new Set();
export function onVibesChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function changed() { for (const listener of listeners) {
    try {
        listener();
    }
    catch { /* View errors stay local. */ }
} }
async function localState() {
    const db = await database();
    const transaction = db.transaction(['items', 'meta'], 'readonly');
    const items = transaction.objectStore('items').getAll();
    const normalize = transaction.objectStore('meta').get('normalize');
    await done(transaction);
    return { normalize: normalize.result === undefined ? true : Boolean(normalize.result), items: items.result };
}
// ── TauriTavern extension data: manifest JSON + content-addressed picture blobs ──
const hostTable = 'vibes';
const hostLock = 'vibes';
function pictureExtension(bytes) {
    if ([137, 80, 78, 71].every((byte, index) => bytes[index] === byte))
        return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        return 'jpg';
    if ([82, 73, 70, 70].every((byte, index) => bytes[index] === byte) && [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte))
        return 'webp';
    return null;
}
async function putPicture(blob, prefix) {
    if (!blob)
        return null;
    const buffer = await blob.arrayBuffer();
    const extension = pictureExtension(new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength)));
    if (!extension)
        fail('氛围参考只支持 PNG、JPEG 或 WebP 图片。');
    // Same picture, same key: metadata edits never duplicate blobs.
    const key = `${prefix}-${await sha256(buffer)}.${extension}`;
    await getHostStore().setBlob({ namespace: HOST_NAMESPACE, table: hostTable, key, data: blob });
    return key;
}
async function getPicture(key, name) {
    if (!key)
        return null;
    try {
        const blob = await getHostStore().getBlob({ namespace: HOST_NAMESPACE, table: hostTable, key });
        const type = key.endsWith('.jpg') ? 'image/jpeg' : key.endsWith('.webp') ? 'image/webp' : 'image/png';
        return blob.slice(0, blob.size, type);
    }
    catch {
        throw new Error(`氛围图“${name}”的同步图片暂不可读，请等待同步完成后重试。`);
    }
}
async function toNative(item) {
    const { image, thumbnail, ...fields } = item;
    return { ...fields, strength: clampUnit(fields.strength), informationExtracted: clampUnit(fields.informationExtracted),
        imageKey: await putPicture(image, 'vibe'), thumbnailKey: await putPicture(thumbnail, 'thumb') };
}
/** An existing native manifest (even empty) wins; otherwise this device's IndexedDB library is migrated once. */
async function nativeManifest() {
    const stored = await readHostJson('manifest', hostTable);
    if (!stored.found) {
        const old = await localState();
        const manifest = { version: 1, normalize: old.normalize, items: [] };
        for (const item of old.items)
            manifest.items.push(await toNative(item));
        await writeHostJson('manifest', manifest, hostTable);
        return manifest;
    }
    const value = stored.value;
    if (!value || value.version !== 1 || !Array.isArray(value.items))
        fail('同步的氛围参考格式无效，未用本机记录覆盖，请检查同步状态。');
    const keyPattern = /^(?:vibe|thumb)-[a-f0-9]{64}\.(?:png|jpg|webp)$/;
    for (const item of value.items) {
        if (!item || typeof item.id !== 'string' || typeof item.hash !== 'string'
            || [item.imageKey, item.thumbnailKey].some(key => key !== null && (typeof key !== 'string' || !keyPattern.test(key)))) {
            fail('同步的氛围参考记录无效，请检查同步状态。');
        }
    }
    return { version: 1, normalize: value.normalize !== false, items: value.items };
}
function hostWrite(update) {
    return withHostLock(hostLock, async () => {
        const manifest = await nativeManifest();
        await update(manifest);
        // Pictures are written first; the manifest only references blobs that already exist.
        await writeHostJson('manifest', manifest, hostTable);
    });
}
export async function loadVibes() {
    let state;
    if (getHostStore()) {
        state = await withHostLock(hostLock, async () => {
            const manifest = await nativeManifest();
            const items = [];
            for (const { imageKey, thumbnailKey, ...fields } of manifest.items) {
                items.push({ ...fields, image: await getPicture(imageKey, fields.name), thumbnail: await getPicture(thumbnailKey, fields.name) });
            }
            return { normalize: manifest.normalize, items };
        });
    }
    else
        state = await localState();
    state.items.sort((a, b) => a.createdAt - b.createdAt);
    return state;
}
export async function saveVibe(item) {
    if (getHostStore()) {
        await hostWrite(async (manifest) => {
            const native = await toNative(item);
            const index = manifest.items.findIndex(entry => entry.id === item.id);
            if (index >= 0)
                manifest.items[index] = native;
            else
                manifest.items.push(native);
        });
    }
    else {
        const db = await database();
        const transaction = db.transaction('items', 'readwrite');
        transaction.objectStore('items').put({ ...item, strength: clampUnit(item.strength), informationExtracted: clampUnit(item.informationExtracted) });
        await done(transaction);
    }
    changed();
}
export async function deleteVibe(id) {
    if (getHostStore()) {
        // Blobs stay behind for in-flight sync readers, same as character portraits.
        await hostWrite(manifest => { manifest.items = manifest.items.filter(entry => entry.id !== id); });
    }
    else {
        const db = await database();
        const transaction = db.transaction('items', 'readwrite');
        transaction.objectStore('items').delete(id);
        await done(transaction);
    }
    changed();
}
export async function saveVibeNormalize(value) {
    if (getHostStore())
        await hostWrite(manifest => { manifest.normalize = value; });
    else {
        const db = await database();
        const transaction = db.transaction('meta', 'readwrite');
        transaction.objectStore('meta').put(value, 'normalize');
        await done(transaction);
    }
    changed();
}
// ── Adding pictures and .naiv4vibe files ──
export async function vibeFromImage(file, name) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type))
        fail('氛围参考只支持 PNG、JPEG 或 WebP 图片。');
    if (!file.size || file.size > VIBE_IMAGE_LIMIT)
        fail('氛围参考图片须小于 8 MiB。');
    const hash = await sha256(await file.arrayBuffer());
    return {
        id: newId(), name: name.replace(/\.[^.]+$/, '').slice(0, 120) || '氛围图', enabled: true,
        strength: 0.6, informationExtracted: 1, image: file, thumbnail: null, hash, encodings: {}, createdAt: Date.now(),
    };
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function unit(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? clampUnit(value) : fallback;
}
async function vibeFromJson(source, offset) {
    if (source.identifier !== 'novelai-vibe-transfer')
        fail('文件不是 NovelAI 氛围参考（.naiv4vibe）。');
    const encodings = {};
    for (const [model, entries] of Object.entries(record(source.encodings))) {
        if (!LONG_NAMES[model])
            continue;
        for (const entry of Object.values(record(entries))) {
            const value = record(entry);
            if (typeof value.encoding !== 'string' || !value.encoding)
                continue;
            const ie = unit(record(value.params).information_extracted, 1);
            (encodings[model] ??= {})[ieKey(ie)] = value.encoding;
        }
    }
    const imageText = typeof source.image === 'string' && source.image ? source.image : '';
    const thumbText = typeof source.thumbnail === 'string' && source.thumbnail ? source.thumbnail : '';
    const toBlob = (text) => {
        try {
            return base64ToBlob(text, /^data:image\/jpeg/.test(text) ? 'image/jpeg' : /^data:image\/webp/.test(text) ? 'image/webp' : 'image/png');
        }
        catch {
            return null;
        }
    };
    const image = imageText ? toBlob(imageText) : null;
    const thumbnail = thumbText ? toBlob(thumbText) : null;
    if (!image && !Object.keys(encodings).length)
        fail('氛围参考文件既没有原图也没有可用编码。');
    if (image && image.size > VIBE_IMAGE_LIMIT)
        fail('氛围参考原图须小于 8 MiB。');
    const info = record(source.importInfo);
    const hash = image ? await sha256(await image.arrayBuffer()) : await sha256(new TextEncoder().encode(JSON.stringify(encodings)));
    return {
        id: newId(), name: (typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '导入的氛围图').slice(0, 120),
        enabled: true, strength: unit(info.strength, 0.6), informationExtracted: unit(info.information_extracted, 1),
        image, thumbnail, hash, encodings, createdAt: Date.now() + offset,
    };
}
/** Accepts a single .naiv4vibe or a .naiv4vibeBundle. */
export async function vibesFromFile(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return fail('氛围参考文件不是有效的 JSON。');
    }
    const source = record(parsed);
    if (source.identifier === 'novelai-vibe-transfer-bundle' || Array.isArray(source.vibes)) {
        const vibes = Array.isArray(source.vibes) ? source.vibes : [];
        if (!vibes.length)
            fail('氛围参考合集是空的。');
        if (vibes.length > VIBE_LIMIT)
            fail(`氛围参考合集超过 ${VIBE_LIMIT} 张。`);
        return Promise.all(vibes.map((vibe, index) => vibeFromJson(record(vibe), index)));
    }
    return [await vibeFromJson(source, 0)];
}
function vibeJson(item, image, thumbnail) {
    const encodings = {};
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
export async function exportVibeBundle(items) {
    const vibes = [];
    for (const item of items) {
        vibes.push(vibeJson(item, item.image ? await blobToBase64(item.image) : '', item.thumbnail ? await blobToBase64(item.thumbnail) : ''));
    }
    return new Blob([JSON.stringify({ identifier: 'novelai-vibe-transfer-bundle', version: 1, vibes })], { type: 'application/json' });
}
// ── Encoding and request fields ──
export function encodeEndpoint(connection) {
    if (connection.channel === 'official')
        return 'https://image.novelai.net/ai/encode-vibe';
    let url;
    try {
        url = new URL(connection.url.trim());
    }
    catch {
        return fail('请输入完整的自定义 URL。');
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (connection.appendSuffix) {
        url.pathname = `${path.replace(/\/ai\/generate-image$/, '')}/ai/encode-vibe`;
        return url.href;
    }
    if (!path.endsWith('/ai/generate-image')) {
        fail('自定义地址不以 /ai/generate-image 结尾，无法推算氛围编码地址。请开启自动拼接后缀，或导入自带编码的 .naiv4vibe 文件。');
    }
    url.pathname = path.replace(/\/ai\/generate-image$/, '/ai/encode-vibe');
    return url.href;
}
export async function encodeVibe(connection, image, model, informationExtracted, signal) {
    const key = connection.key.trim().replace(/^Bearer\s+/i, '');
    if (!key)
        fail('请填写有效的 API 密钥。');
    const body = JSON.stringify({ image: await blobToBase64(image), model, information_extracted: clampUnit(informationExtracted) });
    let response;
    try {
        response = await fetch(encodeEndpoint(connection), {
            method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body, signal,
        });
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        return fail('氛围编码请求未完成，请检查网络、跨域或反代是否转发 /ai/encode-vibe。', 'network');
    }
    if (!response.ok) {
        void response.body?.cancel().catch(() => { });
        if (response.status === 401 || response.status === 403)
            fail('氛围编码失败：密钥无效或没有权限。', 'auth');
        if (response.status === 402)
            fail('氛围编码失败：Anlas 不足（每张编码 2 Anlas）。', 'quota');
        if (response.status === 429)
            fail('氛围编码请求过多，请稍后重试。', 'busy');
        fail(`氛围编码失败（HTTP ${response.status}）。所选模型可能不支持氛围参考。`, 'unknown');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length)
        fail('氛围编码接口返回了空数据。', 'unknown');
    return bytesToBase64(bytes);
}
/**
 * Build request fields for the enabled vibes. Missing encodings are fetched once and cached;
 * returns null when nothing is enabled or the model cannot take vibes (V5 is skipped silently).
 */
export async function prepareVibeReferences(connection, model, signal) {
    const support = vibeSupport(model);
    if (support === 'unavailable')
        return null;
    let state;
    try {
        state = await loadVibes();
    }
    catch {
        return null;
    }
    const enabled = state.items.filter(item => item.enabled);
    if (!enabled.length)
        return null;
    if (enabled.length > VIBE_LIMIT)
        fail(`同时启用的氛围参考最多 ${VIBE_LIMIT} 张。`);
    const result = { images: [], strengths: [], informationExtracted: [], normalize: state.normalize, encoded: 0 };
    const short = SHORT_NAMES[model];
    for (const item of enabled) {
        signal.throwIfAborted();
        const ie = clampUnit(item.informationExtracted);
        if (support === 'raw') {
            if (!item.image)
                fail(`氛围图“${item.name}”没有原图，V3 需要原图；请换一张或改用 V4 / V4.5。`);
            result.images.push(await blobToBase64(item.image));
        }
        else {
            let encoding = item.encodings[short]?.[ieKey(ie)];
            if (!encoding) {
                if (!item.image) {
                    const have = Object.keys(item.encodings).map(name => LONG_NAMES[name] ?? name).join('、') || '无';
                    fail(`氛围图“${item.name}”没有原图，也没有当前模型与信息提取度 ${ieKey(ie)} 的编码（已有：${have}）。请切换模型或调回原来的信息提取度。`);
                }
                encoding = await encodeVibe(connection, item.image, model, ie, signal);
                result.encoded++;
                const next = { ...item, encodings: { ...item.encodings, [short]: { ...item.encodings[short], [ieKey(ie)]: encoding } } };
                try {
                    await saveVibe(next);
                }
                catch { /* The request can still use it; only the cache is lost. */ }
            }
            result.images.push(encoding);
        }
        result.strengths.push(clampUnit(item.strength));
        result.informationExtracted.push(ie);
    }
    return result;
}
/** Whether an item would need a paid encoding for this model at its current settings. */
export function needsEncoding(item, model) {
    const short = SHORT_NAMES[model];
    return Boolean(short) && !item.encodings[short]?.[ieKey(item.informationExtracted)];
}
