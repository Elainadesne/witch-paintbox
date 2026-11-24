import type { PetFault } from './pet-events.js';

// Shared byte validation; never trusts a service MIME type or filename.
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export class ImageResponseError extends Error {
  constructor(message: string, readonly fault: PetFault = 'format') { super(message); }
}
function fail(message: string): never {
  throw new ImageResponseError(message, 'decode');
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
    fail('这串数据看着不像正经的 PNG 图片。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) fail('PNG 图片缺了尾巴，没下全。');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) {
      fail('PNG 图片校验没过，可能传丢了几个字节。');
    }
    if (!sawHeader) {
      if (name !== 'IHDR' || length !== 13) fail('PNG 缺少图头尺寸信息。');
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (!width || !height || width > 4096 || height > 4096) fail('PNG 图片尺寸读出来不对劲（或者超 4096 了）。');
      sawHeader = true;
    } else if (name === 'IHDR') fail('PNG 里夹了重复的图头，格式坏了。');
    if (name === 'IDAT') sawData = true;
    offset += length + 12;
    if (name === 'IEND') {
      if (length !== 0 || !sawData || offset !== bytes.length) fail('PNG 的收尾标记不对，文件大概坏了。');
      return;
    }
  }
  fail('PNG 图片没传完整。');
}

export function decodeImageBase64(value: string, signal: AbortSignal): Uint8Array {
  signal.throwIfAborted();
  if (value.length > 46 * 1024 * 1024) fail('接口返回的 base64 图太大了，超出了上限。');
  // Some compatible services include a data URL prefix or line-wrapped base64.
  // The declared MIME is only a hint; readRasterImage validates the actual bytes.
  const source = value.trim().replace(/^data:image\/(?:png|jpe?g|webp);base64,/i, '').replace(/[\t\r\n ]/g, '');
  if (!source || source.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || source.length % 4 === 1
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(source) || (source.includes('=') && source.length % 4)) {
    fail('接口给的 base64 图片格式不对，或者超过 32 MiB 了。');
  }
  let decoded: string;
  try { decoded = atob(source); }
  catch { return fail('这串 base64 图片解不出来，可能传坏了。'); }
  if (decoded.length > MAX_IMAGE_BYTES) fail('解出来的图片超过 32 MiB 上限了。');
  signal.throwIfAborted();
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

