// Bounded PNG/ZIP reader adapted from the exploration handbook image transport.
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export class ImageResponseError extends Error {}
function fail(message: string): never {
  throw new ImageResponseError(message);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  ensureActive: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      ensureActive();
      const { value, done } = await reader.read();
      ensureActive();
      if (done) break;
      length += value.byteLength;
      if (length > limit) fail('图片响应超出允许大小，已停止读取。');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
  ensureActive: () => void,
): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) fail('图片响应超出允许大小，已停止读取。');
  if (!response.body) fail('图片接口没有返回数据。');
  return readBoundedStream(response.body, limit, signal, ensureActive);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function requirePng(bytes: Uint8Array): void {
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

export function requireImageSupport(): void {
  try {
    new DecompressionStream('deflate-raw');
  } catch {
    fail('当前浏览器不支持图片解压，请升级浏览器后再生成；尚未发送生图请求。');
  }
}

/** Read only ordinary single-disk ZIP archives; never extract names to the filesystem. */
async function readSinglePngZip(bytes: Uint8Array, signal: AbortSignal, ensureActive: () => void): Promise<Uint8Array> {
  const invalid = () => fail('NovelAI 返回的图片压缩包格式或校验无效。');
  if (bytes.length < 22 || bytes.length > MAX_IMAGE_BYTES) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const checkExtra = (start: number, length: number) => {
    const end = start + length;
    if (end > bytes.length) return invalid();
    for (let at = start; at < end; ) {
      if (at + 4 > end || view.getUint16(at, true) === 0x0001) return invalid();
      at += 4 + view.getUint16(at + 2, true);
      if (at > end) return invalid();
    }
  };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) return invalid();
  const count = view.getUint16(end + 10, true);
  const directoryLength = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (!count || count > 16 || count !== view.getUint16(end + 8, true) || directoryOffset + directoryLength !== end)
    return invalid();
  let at = directoryOffset;
  let expandedTotal = 0;
  let selected: { start: number; size: number; expanded: number; crc: number; method: number } | undefined;
  const ranges: Array<[number, number]> = [];
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    ensureActive();
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return invalid();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const expanded = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    expandedTotal += expanded;
    // Only UTF-8, deflate tuning flags and an optional data descriptor are supported.
    if (
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      view.getUint16(at + 6, true) > 20 ||
      view.getUint16(at + 34, true) ||
      !nameLength ||
      next > end ||
      size > MAX_IMAGE_BYTES ||
      expandedTotal > MAX_IMAGE_BYTES ||
      local + 30 > directoryOffset
    )
      return invalid();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    checkExtra(at + 46 + nameLength, extraLength);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      return invalid();
    }
    if (
      names.has(name) ||
      /[\\:]/.test(name) ||
      Array.from(name).some(char => char.charCodeAt(0) < 32) ||
      name.startsWith('/') ||
      name.split('/').includes('..')
    )
      return invalid();
    names.add(name);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 4, true) > 20 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      return invalid();
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const start = local + 30 + localNameLength + localExtraLength;
    if (
      start + size > directoryOffset ||
      localNameLength !== nameLength ||
      !nameBytes.every((byte, i) => bytes[local + 30 + i] === byte)
    )
      return invalid();
    checkExtra(local + 30 + localNameLength, localExtraLength);
    let localEnd = start + size;
    if (flags & 8) {
      if (localEnd + 12 > directoryOffset) return invalid();
      const descriptor = view.getUint32(localEnd, true) === 0x08074b50 ? localEnd + 4 : localEnd;
      if (
        descriptor + 12 > directoryOffset ||
        view.getUint32(descriptor, true) !== crc ||
        view.getUint32(descriptor + 4, true) !== size ||
        view.getUint32(descriptor + 8, true) !== expanded
      )
        return invalid();
      localEnd = descriptor + 12;
    } else if (
      view.getUint32(local + 14, true) !== crc ||
      view.getUint32(local + 18, true) !== size ||
      view.getUint32(local + 22, true) !== expanded
    )
      return invalid();
    if (ranges.some(([from, to]) => local < to && localEnd > from)) return invalid();
    ranges.push([local, localEnd]);
    if (method === 0 && size !== expanded) return invalid();
    if (name.toLowerCase().endsWith('.png')) {
      if (selected || !expanded) fail('NovelAI 应返回且仅返回一张 PNG 图片。');
      selected = { start, size, expanded, crc, method };
    }
    at = next;
  }
  if (at !== end || !selected) return invalid();
  const compressed = bytes.slice(selected.start, selected.start + selected.size);
  let image: Uint8Array;
  try {
    image =
      selected.method === 0
        ? compressed
        : await readBoundedStream(
            new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
            selected.expanded,
            signal,
            ensureActive,
          );
  } catch (error) {
    if (error instanceof ImageResponseError) throw error;
    return invalid();
  }
  ensureActive();
  if (image.length !== selected.expanded || crc32(image) !== selected.crc) return invalid();
  requirePng(image);
  return image;
}

export async function readImageResponse(
  response: Response,
  signal: AbortSignal,
  ensureActive: () => void,
): Promise<Blob> {
  const bytes = await readResponse(response, MAX_IMAGE_BYTES, signal, ensureActive);
  const isPng = PNG_MAGIC.every((byte, index) => bytes[index] === byte);
  const image = isPng ? bytes : await readSinglePngZip(bytes, signal, ensureActive);
  if (isPng) requirePng(image);
  ensureActive();
  return new Blob([image.slice()], { type: 'image/png' });
}
