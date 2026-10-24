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

/** Read bounded, single-disk ZIP/ZIP64 archives; never extract names to the filesystem. */
async function readSinglePngZip(bytes: Uint8Array, signal: AbortSignal, ensureActive: () => void): Promise<Uint8Array> {
  const invalid = () => fail('NovelAI 返回的图片压缩包格式或校验无效。');
  if (bytes.length < 22 || bytes.length > MAX_IMAGE_BYTES) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Every supported size, offset and count fits the existing 32 MiB bound.
  // Check the high word before converting ZIP64 integers to JavaScript numbers.
  const uint64 = (at: number, limit = bytes.length): number => {
    if (at + 8 > limit || view.getUint32(at + 4, true)) return invalid();
    const value = view.getUint32(at, true);
    if (value > MAX_IMAGE_BYTES) return invalid();
    return value;
  };
  const readExtra = (start: number, length: number): { start: number; end: number } | undefined => {
    const end = start + length;
    if (end > bytes.length) return invalid();
    let zip64: { start: number; end: number } | undefined;
    for (let at = start; at < end; ) {
      if (at + 4 > end) return invalid();
      const next = at + 4 + view.getUint16(at + 2, true);
      if (next > end) return invalid();
      if (view.getUint16(at, true) === 0x0001) {
        if (zip64) return invalid();
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
  if (end < 0) return invalid();
  let count = view.getUint16(end + 10, true);
  let directoryLength = view.getUint32(end + 12, true);
  let directoryOffset = view.getUint32(end + 16, true);
  let directoryEnd = end;
  const locator = end - 20;
  if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
    if (view.getUint32(locator + 4, true) || view.getUint32(locator + 16, true) !== 1) return invalid();
    const zip64 = uint64(locator + 8);
    if (
      zip64 + 56 > locator ||
      view.getUint32(zip64, true) !== 0x06064b50 ||
      uint64(zip64 + 4) < 44 ||
      zip64 + 12 + uint64(zip64 + 4) !== locator ||
      view.getUint16(zip64 + 14, true) > 45 ||
      view.getUint32(zip64 + 16, true) ||
      view.getUint32(zip64 + 20, true)
    )
      return invalid();
    const zip64Count = uint64(zip64 + 32);
    const zip64Length = uint64(zip64 + 40);
    const zip64Offset = uint64(zip64 + 48);
    const agrees = (ordinary: number, value: number, sentinel: number) => ordinary === sentinel || ordinary === value;
    if (
      uint64(zip64 + 24) !== zip64Count ||
      !agrees(view.getUint16(end + 4, true), 0, 0xffff) ||
      !agrees(view.getUint16(end + 6, true), 0, 0xffff) ||
      !agrees(view.getUint16(end + 8, true), zip64Count, 0xffff) ||
      !agrees(count, zip64Count, 0xffff) ||
      !agrees(directoryLength, zip64Length, 0xffffffff) ||
      !agrees(directoryOffset, zip64Offset, 0xffffffff)
    )
      return invalid();
    count = zip64Count;
    directoryLength = zip64Length;
    directoryOffset = zip64Offset;
    directoryEnd = zip64;
  } else if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    count !== view.getUint16(end + 8, true)
  )
    return invalid();
  if (!count || count > 16 || directoryOffset + directoryLength !== directoryEnd) return invalid();
  let at = directoryOffset;
  let expandedTotal = 0;
  let selected: { start: number; size: number; expanded: number; crc: number; method: number } | undefined;
  const ranges: Array<[number, number]> = [];
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    ensureActive();
    if (at + 46 > directoryEnd || view.getUint32(at, true) !== 0x02014b50) return invalid();
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
    if (next > directoryEnd) return invalid();
    const zip64 = readExtra(at + 46 + nameLength, extraLength);
    let extraAt = zip64?.start ?? 0;
    const extra64 = () => {
      if (!zip64) return invalid();
      const value = uint64(extraAt, zip64.end);
      extraAt += 8;
      return value;
    };
    if (expanded === 0xffffffff) expanded = extra64();
    if (size === 0xffffffff) size = extra64();
    if (local === 0xffffffff) local = extra64();
    if (disk === 0xffff) {
      if (!zip64 || extraAt + 4 > zip64.end) return invalid();
      disk = view.getUint32(extraAt, true);
    }
    expandedTotal += expanded;
    // Only UTF-8, deflate tuning flags and an optional data descriptor are supported.
    if (
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      view.getUint16(at + 6, true) > 45 ||
      disk ||
      !nameLength ||
      size > MAX_IMAGE_BYTES ||
      expandedTotal > MAX_IMAGE_BYTES ||
      local + 30 > directoryOffset
    )
      return invalid();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    let name: string;
    try {
      // Legacy names are only used for byte identity and the ASCII .png suffix.
      // Preserve their bytes instead of treating CP437 names as broken UTF-8.
      name = flags & 0x0800
        ? new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
        : Array.from(nameBytes, byte => String.fromCharCode(byte)).join('');
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
      view.getUint16(local + 4, true) > 45 ||
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
    const localZip64 = readExtra(local + 30 + localNameLength, localExtraLength);
    let localSize = view.getUint32(local + 18, true);
    let localExpanded = view.getUint32(local + 22, true);
    if (localZip64) {
      // Unlike the central directory, local ZIP64 headers always carry both sizes.
      const expanded64 = uint64(localZip64.start, localZip64.end);
      const size64 = uint64(localZip64.start + 8, localZip64.end);
      if (localExpanded === 0xffffffff) localExpanded = expanded64;
      if (localSize === 0xffffffff) localSize = size64;
    } else if (localSize === 0xffffffff || localExpanded === 0xffffffff) return invalid();
    let localEnd = start + size;
    if (flags & 8) {
      const wide = Boolean(localZip64 || zip64);
      const descriptorLength = wide ? 20 : 12;
      const matches = (offset: number) =>
        offset + descriptorLength <= directoryOffset &&
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
      } else if (matches(localEnd)) localEnd += descriptorLength;
      else return invalid();
    } else if (
      view.getUint32(local + 14, true) !== crc ||
      localSize !== size ||
      localExpanded !== expanded
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
  if (at !== directoryEnd || !selected) return invalid();
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
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isPng && !isZip) {
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
    // Never echo arbitrary upstream content: it may contain credentials or HTML.
    if (!bytes.length) fail('生图服务没有返回图片数据。');
    if (/^<(?:!doctype\s+html|html\b)/i.test(prefix) || type.includes('text/html')) {
      fail('生图服务返回了 HTML 网页，没有返回图片。请检查服务 URL 是否为生图接口，或是否被登录页、网关拦截。');
    }
    if (/^[\[{]/.test(prefix) || type.includes('json')) {
      fail('生图服务返回了 JSON 数据，没有返回 PNG 图片或图片压缩包。请检查密钥、服务额度和接口兼容性。');
    }
    if (type.startsWith('image/')) fail('生图服务返回了非 PNG 图片；当前仅支持 PNG 图片或包含 PNG 的压缩包。');
    fail('生图服务返回了无法识别的数据；当前仅支持 PNG 图片或包含 PNG 的压缩包。请检查服务 URL 和接口兼容性。');
  }
  const image = isPng ? bytes : await readSinglePngZip(bytes, signal, ensureActive);
  if (isPng) requirePng(image);
  ensureActive();
  return new Blob([image.slice()], { type: 'image/png' });
}
