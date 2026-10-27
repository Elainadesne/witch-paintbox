import { ImageResponseError, MAX_IMAGE_BYTES, crc32, decodeImageBase64 } from './image-bytes.js';
import { rasterImageType, readRasterImage } from './raster-image.js';
export { ImageResponseError } from './image-bytes.js';
const MAX_ENCODED_BYTES = 46 * 1024 * 1024;
function fail(message) { throw new ImageResponseError(message); }
async function readBoundedStream(stream, limit, signal, ensureActive) {
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    const abort = () => {
        void reader.cancel().catch(() => { });
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            ensureActive();
            const { value, done } = await reader.read();
            ensureActive();
            if (done)
                break;
            length += value.byteLength;
            if (length > limit)
                fail('图片响应超出允许大小，已停止读取。');
            chunks.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }
    finally {
        signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
async function readResponse(response, limit, signal, ensureActive) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > limit) {
        void response.body?.cancel().catch(() => { });
        fail('图片响应超出允许大小，已停止读取。');
    }
    if (!response.body)
        fail('图片接口没有返回数据。');
    return readBoundedStream(response.body, limit, signal, ensureActive);
}
export function requireImageSupport() {
    try {
        new DecompressionStream('deflate-raw');
    }
    catch {
        fail('当前浏览器不支持图片解压，请升级浏览器后再生成；尚未发送生图请求。');
    }
}
/** Read bounded, single-disk ZIP/ZIP64 archives; never extract names to the filesystem. */
async function readSingleImageZip(bytes, signal, ensureActive) {
    const invalid = () => fail('NovelAI 返回的图片压缩包格式或校验无效。');
    if (bytes.length < 22 || bytes.length > MAX_IMAGE_BYTES)
        return invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Every supported size, offset and count fits the existing 32 MiB bound.
    // Check the high word before converting ZIP64 integers to JavaScript numbers.
    const uint64 = (at, limit = bytes.length) => {
        if (at + 8 > limit || view.getUint32(at + 4, true))
            return invalid();
        const value = view.getUint32(at, true);
        if (value > MAX_IMAGE_BYTES)
            return invalid();
        return value;
    };
    const readExtra = (start, length) => {
        const end = start + length;
        if (end > bytes.length)
            return invalid();
        let zip64;
        for (let at = start; at < end;) {
            if (at + 4 > end)
                return invalid();
            const next = at + 4 + view.getUint16(at + 2, true);
            if (next > end)
                return invalid();
            if (view.getUint16(at, true) === 0x0001) {
                if (zip64)
                    return invalid();
                zip64 = { start: at + 4, end: next };
            }
            at = next;
        }
        return zip64;
    };
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
        if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) {
            end = at;
            break;
        }
    }
    if (end < 0)
        return invalid();
    let count = view.getUint16(end + 10, true);
    let directoryLength = view.getUint32(end + 12, true);
    let directoryOffset = view.getUint32(end + 16, true);
    let directoryEnd = end;
    const locator = end - 20;
    if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
        if (view.getUint32(locator + 4, true) || view.getUint32(locator + 16, true) !== 1)
            return invalid();
        const zip64 = uint64(locator + 8);
        if (zip64 + 56 > locator ||
            view.getUint32(zip64, true) !== 0x06064b50 ||
            uint64(zip64 + 4) < 44 ||
            zip64 + 12 + uint64(zip64 + 4) !== locator ||
            view.getUint16(zip64 + 14, true) > 45 ||
            view.getUint32(zip64 + 16, true) ||
            view.getUint32(zip64 + 20, true))
            return invalid();
        const zip64Count = uint64(zip64 + 32);
        const zip64Length = uint64(zip64 + 40);
        const zip64Offset = uint64(zip64 + 48);
        const agrees = (ordinary, value, sentinel) => ordinary === sentinel || ordinary === value;
        if (uint64(zip64 + 24) !== zip64Count ||
            !agrees(view.getUint16(end + 4, true), 0, 0xffff) ||
            !agrees(view.getUint16(end + 6, true), 0, 0xffff) ||
            !agrees(view.getUint16(end + 8, true), zip64Count, 0xffff) ||
            !agrees(count, zip64Count, 0xffff) ||
            !agrees(directoryLength, zip64Length, 0xffffffff) ||
            !agrees(directoryOffset, zip64Offset, 0xffffffff))
            return invalid();
        count = zip64Count;
        directoryLength = zip64Length;
        directoryOffset = zip64Offset;
        directoryEnd = zip64;
    }
    else if (view.getUint16(end + 4, true) ||
        view.getUint16(end + 6, true) ||
        count !== view.getUint16(end + 8, true))
        return invalid();
    if (!count || count > 16 || directoryOffset + directoryLength !== directoryEnd)
        return invalid();
    let at = directoryOffset;
    let expandedTotal = 0;
    let selected;
    let soleFile;
    let fileCount = 0;
    const ranges = [];
    const names = new Set();
    for (let index = 0; index < count; index++) {
        ensureActive();
        if (at + 46 > directoryEnd || view.getUint32(at, true) !== 0x02014b50)
            return invalid();
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        let size = view.getUint32(at + 20, true);
        let expanded = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        let disk = view.getUint16(at + 34, true);
        let local = view.getUint32(at + 42, true);
        const next = at + 46 + nameLength + extraLength + commentLength;
        if (next > directoryEnd)
            return invalid();
        const zip64 = readExtra(at + 46 + nameLength, extraLength);
        let extraAt = zip64?.start ?? 0;
        const extra64 = () => {
            if (!zip64)
                return invalid();
            const value = uint64(extraAt, zip64.end);
            extraAt += 8;
            return value;
        };
        if (expanded === 0xffffffff)
            expanded = extra64();
        if (size === 0xffffffff)
            size = extra64();
        if (local === 0xffffffff)
            local = extra64();
        if (disk === 0xffff) {
            if (!zip64 || extraAt + 4 > zip64.end)
                return invalid();
            disk = view.getUint32(extraAt, true);
        }
        expandedTotal += expanded;
        // Only UTF-8, deflate tuning flags and an optional data descriptor are supported.
        if (flags & ~0x080e ||
            ![0, 8].includes(method) ||
            view.getUint16(at + 6, true) > 45 ||
            disk ||
            !nameLength ||
            size > MAX_IMAGE_BYTES ||
            expandedTotal > MAX_IMAGE_BYTES ||
            local + 30 > directoryOffset)
            return invalid();
        const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
        let name;
        try {
            // Legacy names are only used for byte identity and ASCII image suffixes.
            // Preserve their bytes instead of treating CP437 names as broken UTF-8.
            name = flags & 0x0800
                ? new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
                : Array.from(nameBytes, byte => String.fromCharCode(byte)).join('');
        }
        catch {
            return invalid();
        }
        if (names.has(name) ||
            /[\\:]/.test(name) ||
            Array.from(name).some(char => char.charCodeAt(0) < 32) ||
            name.startsWith('/') ||
            name.split('/').includes('..'))
            return invalid();
        names.add(name);
        if (view.getUint32(local, true) !== 0x04034b50 ||
            view.getUint16(local + 4, true) > 45 ||
            view.getUint16(local + 6, true) !== flags ||
            view.getUint16(local + 8, true) !== method)
            return invalid();
        const localNameLength = view.getUint16(local + 26, true);
        const localExtraLength = view.getUint16(local + 28, true);
        const start = local + 30 + localNameLength + localExtraLength;
        if (start + size > directoryOffset ||
            localNameLength !== nameLength ||
            !nameBytes.every((byte, i) => bytes[local + 30 + i] === byte))
            return invalid();
        const localZip64 = readExtra(local + 30 + localNameLength, localExtraLength);
        let localSize = view.getUint32(local + 18, true);
        let localExpanded = view.getUint32(local + 22, true);
        if (localZip64) {
            // Unlike the central directory, local ZIP64 headers always carry both sizes.
            const expanded64 = uint64(localZip64.start, localZip64.end);
            const size64 = uint64(localZip64.start + 8, localZip64.end);
            if (localExpanded === 0xffffffff)
                localExpanded = expanded64;
            if (localSize === 0xffffffff)
                localSize = size64;
        }
        else if (localSize === 0xffffffff || localExpanded === 0xffffffff)
            return invalid();
        let localEnd = start + size;
        if (flags & 8) {
            const wide = Boolean(localZip64 || zip64);
            const descriptorLength = wide ? 20 : 12;
            const matches = (offset) => offset + descriptorLength <= directoryOffset &&
                view.getUint32(offset, true) === crc &&
                view.getUint32(offset + 4, true) === size &&
                (wide
                    ? view.getUint32(offset + 8, true) === 0 &&
                        view.getUint32(offset + 12, true) === expanded &&
                        view.getUint32(offset + 16, true) === 0
                    : view.getUint32(offset + 8, true) === expanded);
            // Try both forms: an unsigned descriptor's CRC may equal the signature.
            if (localEnd + 4 <= directoryOffset && view.getUint32(localEnd, true) === 0x08074b50 && matches(localEnd + 4)) {
                localEnd += 4 + descriptorLength;
            }
            else if (matches(localEnd))
                localEnd += descriptorLength;
            else
                return invalid();
        }
        else if (view.getUint32(local + 14, true) !== crc ||
            localSize !== size ||
            localExpanded !== expanded)
            return invalid();
        if (ranges.some(([from, to]) => local < to && localEnd > from))
            return invalid();
        ranges.push([local, localEnd]);
        if (method === 0 && size !== expanded)
            return invalid();
        if (!name.endsWith('/')) {
            soleFile = { start, size, expanded, crc, method };
            fileCount++;
        }
        if (/\.(?:png|jpe?g|webp)$/i.test(name)) {
            if (selected || !expanded)
                fail('生图压缩包应包含且仅包含一张图片。');
            selected = { start, size, expanded, crc, method };
        }
        at = next;
    }
    if (at !== directoryEnd)
        return invalid();
    // Some proxies omit the extension. Only use this fallback for a single file;
    // the extracted bytes still go through the same format and integrity checks.
    selected ??= fileCount === 1 ? soleFile : undefined;
    if (!selected)
        fail('生图压缩包中没有找到唯一的 PNG、JPEG 或 WebP 图片。');
    const compressed = bytes.slice(selected.start, selected.start + selected.size);
    let image;
    try {
        image =
            selected.method === 0
                ? compressed
                : await readBoundedStream(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')), selected.expanded, signal, ensureActive);
    }
    catch (error) {
        ensureActive();
        if (error instanceof ImageResponseError)
            throw error;
        return invalid();
    }
    ensureActive();
    if (image.length !== selected.expanded || crc32(image) !== selected.crc)
        return invalid();
    return image;
}
/** Accept explicit, single-image JSON envelopes; do not search arbitrary error text. */
function imageReference(payload) {
    for (let depth = 0; depth < 4; depth++) {
        if (typeof payload === 'string' && payload.trim())
            return payload.trim();
        if (Array.isArray(payload)) {
            if (payload.length !== 1)
                fail('生图接口应返回且仅返回一张图片。');
            payload = payload[0];
            continue;
        }
        if (!payload || typeof payload !== 'object')
            break;
        const item = payload;
        if (item.error || item.success === false)
            fail('生图接口返回了错误数据，请检查密钥、额度和接口兼容性。');
        for (const key of ['b64_json', 'base64', 'image', 'url']) {
            if (typeof item[key] === 'string' && item[key].trim())
                return item[key].trim();
        }
        payload = item.data ?? item.images;
    }
    return fail('生图接口返回了 JSON，但未包含可识别的图片数据或图片 URL；请检查密钥、额度和接口兼容性。');
}
async function readImageReference(value, signal, ensureActive) {
    ensureActive();
    if (!/^https?:/i.test(value))
        return decodeImageBase64(value, signal);
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return fail('接口返回的图片 URL 无效。');
    }
    if (value.length > 8192 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
        fail('接口返回的图片 URL 不受支持。');
    }
    // Fetch only the returned image, once. Never forward the API key or cookies.
    let response;
    try {
        response = await fetch(url.href, {
            signal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        });
    }
    catch {
        ensureActive();
        return fail('无法读取接口返回的图片 URL，请检查图片地址、跨域访问或重定向设置；没有重新发起生图。');
    }
    ensureActive();
    if (!response.ok) {
        void response.body?.cancel().catch(() => { });
        fail(`读取图片 URL 失败（HTTP ${response.status}）；没有重新发起生图。`);
    }
    return readResponse(response, MAX_IMAGE_BYTES, signal, ensureActive);
}
export async function readImageResponse(response, signal, ensureActive) {
    let bytes = await readResponse(response, MAX_ENCODED_BYTES, signal, ensureActive);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (isZip)
        bytes = await readSingleImageZip(bytes, signal, ensureActive);
    if (!rasterImageType(bytes)) {
        const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
        // Never echo arbitrary upstream content: it may contain credentials or HTML.
        if (!bytes.length)
            fail('生图服务没有返回图片数据。');
        if (prefix.startsWith('<')) {
            fail('生图服务返回了 HTML 网页，没有返回图片。请检查服务 URL 是否为生图接口，或是否被登录页、网关拦截。');
        }
        const isJson = /^[\[{"]/.test(prefix);
        const isBase64 = /^data:image\//i.test(prefix) || /^[A-Za-z0-9+/\s]+=*$/.test(prefix);
        const isUrl = /^https?:\/\//i.test(prefix);
        if (!isJson && !isBase64 && !isUrl)
            fail('生图服务返回了无法识别的数据；支持 PNG、JPEG、WebP、图片压缩包及 base64 / JSON 图片。');
        let source;
        try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
        }
        catch {
            return fail('生图服务返回的数据既不是有效图片，也不是可识别的文本图片数据。');
        }
        if (isJson) {
            let payload;
            try {
                payload = JSON.parse(source);
            }
            catch {
                return fail('生图接口返回的 JSON 不完整或格式无效。');
            }
            source = imageReference(payload);
        }
        bytes = await readImageReference(source, signal, ensureActive);
    }
    const image = await readRasterImage(bytes, signal);
    ensureActive();
    return image.blob;
}
