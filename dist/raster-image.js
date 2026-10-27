import { ImageResponseError, MAX_IMAGE_BYTES, PNG_MAGIC, requirePng } from './image-bytes.js';
function fail(message) { throw new ImageResponseError(message); }
function dimensions(width, height) {
    if (!width || !height || width > 4096 || height > 4096)
        fail('图片尺寸无效或超过 4096 像素。');
    return { width, height };
}
function jpegDimensions(bytes) {
    const invalid = () => fail('JPEG 图片结构无效或数据不完整。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let frame;
    let components = 0;
    let offset = 2;
    let inScan = false;
    let sawScan = false;
    // Walk every marker, including those between progressive scans. A later frame
    // must not replace the dimensions checked before the browser allocates pixels.
    while (offset < bytes.length) {
        if (inScan) {
            offset = bytes.indexOf(0xff, offset);
            if (offset < 0)
                return invalid();
        }
        if (bytes[offset++] !== 0xff)
            return invalid();
        while (bytes[offset] === 0xff)
            offset++;
        if (offset >= bytes.length)
            return invalid();
        const marker = bytes[offset++];
        if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)))
            continue;
        inScan = false;
        if (marker === 0xd9) {
            if (!frame || !sawScan || offset !== bytes.length)
                return invalid();
            return frame;
        }
        if (marker < 0xc0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)
            || marker === 0xdc || marker === 0xde || offset + 2 > bytes.length)
            return invalid();
        const length = view.getUint16(offset);
        if (length < 2 || length > bytes.length - offset)
            return invalid();
        const isFrame = marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isFrame) {
            if (frame || length < 8)
                return invalid();
            components = bytes[offset + 7];
            if (!components || components > 4 || length !== 8 + 3 * components)
                return invalid();
            frame = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        }
        else if (marker === 0xda) {
            if (!frame || length < 6 || !bytes[offset + 2] || bytes[offset + 2] > components
                || length !== 6 + 2 * bytes[offset + 2])
                return invalid();
            sawScan = true;
            inScan = true;
        }
        offset += length;
    }
    return invalid();
}
function webpDimensions(bytes) {
    const invalid = () => fail('WebP 图片结构无效或数据不完整。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || view.getUint32(4, true) !== bytes.length - 8)
        return invalid();
    const uint24 = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    let canvas;
    let frame;
    let offset = 12;
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length)
            return invalid();
        const name = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const length = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const next = start + length + (length & 1);
        if (next > bytes.length)
            return invalid();
        if (name === 'ANIM' || name === 'ANMF')
            fail('接口返回了动态 WebP；当前仅支持单张静态图片。');
        if (name === 'VP8X') {
            if (offset !== 12 || length !== 10 || canvas || bytes[start] & 0xc1
                || bytes[start + 1] || bytes[start + 2] || bytes[start + 3])
                return invalid();
            if (bytes[start] & 2)
                fail('接口返回了动态 WebP；当前仅支持单张静态图片。');
            canvas = dimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
        }
        else if (name === 'VP8 ') {
            if (frame || length < 10 || bytes[start] & 1 || bytes[start + 3] !== 0x9d
                || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a)
                return invalid();
            frame = dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
        }
        else if (name === 'VP8L') {
            if (frame || length < 5 || bytes[start] !== 0x2f)
                return invalid();
            const bits = view.getUint32(start + 1, true);
            if (bits >>> 29)
                return invalid();
            frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        offset = next;
    }
    if (!frame || (canvas && (frame.width !== canvas.width || frame.height !== canvas.height)))
        return invalid();
    return frame;
}
async function decodeImage(blob, expected, signal) {
    signal.throwIfAborted();
    if (typeof Image !== 'function' || typeof URL.createObjectURL !== 'function') {
        fail('当前浏览器不支持图片解码，请升级浏览器或 WebView 后重试。');
    }
    let image;
    let url;
    try {
        image = new Image();
        url = URL.createObjectURL(blob);
    }
    catch {
        return fail('当前浏览器无法读取图片，请检查浏览器或 WebView 支持。');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', abort);
            image.onload = null;
            image.onerror = null;
            image.removeAttribute('src');
            URL.revokeObjectURL(url);
            if (error !== undefined)
                reject(error);
            else
                resolve(value);
        };
        const abort = () => finish(new DOMException('图片读取已取消。', 'AbortError'));
        const invalid = () => finish(new ImageResponseError('图片无法解码：数据可能损坏，或当前浏览器不支持此图片格式。'));
        const loaded = () => {
            if (settled)
                return;
            if (signal.aborted) {
                abort();
                return;
            }
            const width = image.naturalWidth;
            const height = image.naturalHeight;
            // EXIF orientation can exchange the displayed width and height.
            if (!width || !height || width > 4096 || height > 4096
                || !((width === expected.width && height === expected.height)
                    || (width === expected.height && height === expected.width))) {
                invalid();
                return;
            }
            finish(undefined, { width, height });
        };
        image.onerror = invalid;
        image.onload = () => {
            if (settled)
                return;
            // Image loading remains the fallback for older WebViews without decode().
            if (typeof image.decode === 'function') {
                try {
                    void image.decode().then(loaded, invalid);
                }
                catch {
                    invalid();
                }
            }
            else
                loaded();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
            return;
        }
        try {
            image.src = url;
        }
        catch {
            invalid();
        }
    });
}
export function rasterImageType(bytes) {
    if (PNG_MAGIC.every((byte, index) => bytes[index] === byte))
        return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP')
        return 'image/webp';
    return undefined;
}
/** Validate original raster bytes without converting their format or metadata. */
export async function readRasterImage(bytes, signal) {
    signal.throwIfAborted();
    if (!bytes.length)
        fail('生图接口没有返回图片数据。');
    if (bytes.length > MAX_IMAGE_BYTES)
        fail('接口返回的图片超过 32 MiB。');
    const type = rasterImageType(bytes);
    if (type === 'image/png') {
        requirePng(bytes);
        const blob = new Blob([bytes.slice()], { type });
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { blob, width: view.getUint32(16), height: view.getUint32(20) };
    }
    let expected;
    if (type === 'image/jpeg') {
        expected = jpegDimensions(bytes);
    }
    else if (type === 'image/webp') {
        expected = webpDimensions(bytes);
    }
    else {
        // Never include upstream text in errors; it may contain HTML or credentials.
        const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
        if (/^<(?:!doctype\s+html|html\b)/i.test(prefix)) {
            fail('生图接口返回了 HTML 网页，请检查接口地址或登录、网关拦截情况。');
        }
        if (/^[\[{]/.test(prefix))
            fail('生图接口返回了 JSON 数据，请检查密钥、额度和接口兼容性。');
        if (bytes[0] === 0x50 && bytes[1] === 0x4b)
            fail('图片内容仍是压缩包；请让接口返回单张 PNG、JPEG 或 WebP 图片。');
        fail('生图接口未返回可识别的图片；当前支持 PNG、JPEG 和 WebP，请检查接口兼容性。');
    }
    const blob = new Blob([bytes.slice()], { type });
    const size = await decodeImage(blob, expected, signal);
    signal.throwIfAborted();
    return { blob, ...size };
}
export function imageFileExtension(blob) {
    if (blob.type === 'image/png')
        return 'png';
    if (blob.type === 'image/jpeg')
        return 'jpg';
    if (blob.type === 'image/webp')
        return 'webp';
    return fail('图片格式不受支持，无法确定下载扩展名。');
}
