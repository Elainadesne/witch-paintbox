// Shared byte validation; never trusts a service MIME type or filename.
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export class ImageResponseError extends Error {}
function fail(message: string): never {
  throw new ImageResponseError(message);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function requirePng(bytes: Uint8Array): void {
  if (bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || !PNG_MAGIC.every((byte, i) => bytes[i] === byte)) {
    fail('图片内容不是有效的 PNG。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) fail('PNG 图片数据不完整。');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) {
      fail('PNG 图片校验失败。');
    }
    if (!sawHeader) {
      if (name !== 'IHDR' || length !== 13) fail('PNG 图片缺少有效尺寸。');
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (!width || !height || width > 4096 || height > 4096) fail('PNG 图片尺寸无效。');
      sawHeader = true;
    } else if (name === 'IHDR') fail('PNG 图片包含重复头信息。');
    if (name === 'IDAT') sawData = true;
    offset += length + 12;
    if (name === 'IEND') {
      if (length !== 0 || !sawData || offset !== bytes.length) fail('PNG 图片结束标记无效。');
      return;
    }
  }
  fail('PNG 图片数据不完整。');
}

export function decodeImageBase64(value: string, signal: AbortSignal): Uint8Array {
  signal.throwIfAborted();
  if (value.length > 46 * 1024 * 1024) fail('接口返回的 base64 图片超过允许大小。');
  // Some compatible services include a data URL prefix or line-wrapped base64.
  // The declared MIME is only a hint; readRasterImage validates the actual bytes.
  const source = value.trim().replace(/^data:image\/(?:png|jpe?g|webp);base64,/i, '').replace(/[\t\r\n ]/g, '');
  if (!source || source.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || source.length % 4 === 1
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(source) || (source.includes('=') && source.length % 4)) {
    fail('接口返回的 base64 图片无效或超过 32 MiB。');
  }
  let decoded: string;
  try { decoded = atob(source); }
  catch { return fail('接口返回的 base64 图片无法解码。'); }
  if (decoded.length > MAX_IMAGE_BYTES) fail('接口返回的图片超过 32 MiB。');
  signal.throwIfAborted();
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

