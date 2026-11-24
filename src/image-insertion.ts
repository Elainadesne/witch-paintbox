import { MAX_IMAGE_MARKERS, MAX_MARKER_TEXT_LENGTH, MAX_ORIGINAL_LENGTH, parseImageMarkers, type ImageMarker } from './image-markers.js';
import { imageTextRegions, textLines, type TextRegion } from './image-text-regions.js';
import { imageSizeMetadata, parseImageSize, type ImageSize } from './image-size.js';
import { withFault } from './pet-events.js';
import type { IllustrationItem } from './illustration-selection.js';

export interface ImageInsertionPoint { readonly id: string; readonly offset: number }
export interface ImageInsertionPlan {
  readonly original: string;
  readonly text: string;
  readonly points: readonly ImageInsertionPoint[];
}

function newline(text: string): string { return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n'; }

interface NarrativeSpan { start: number; end: number }

export interface ImageSentenceSpan {
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
  readonly hasProse: boolean;
}

/** Source offsets, not rendered lines. Opaque code, image blocks and HTML tokens stay whole. */
export function imageSentenceSpans(text: string, regions: readonly TextRegion[] = imageTextRegions(text)): ImageSentenceSpan[] {
  const spans: ImageSentenceSpan[] = [];
  const narrativeEdges = new Set(narrativeSpans(text, regions).flatMap(span => [span.start, span.end]));
  let start = 0;
  let at = 0;
  let regionIndex = 0;
  let hasProse = false;
  const append = (end: number, terminated: boolean) => {
    if (end > start) spans.push({ start, end, terminated, hasProse });
    start = end;
    hasProse = false;
  };
  while (at < text.length) {
    if (narrativeEdges.has(at) && at > start) append(at, false);
    while (regionIndex < regions.length && regions[regionIndex].end <= at) regionIndex++;
    const region = regions[regionIndex];
    if (region && region.start === at) { at = region.end; continue; }
    const character = text[at];
    if (/\r|\n/.test(character)) {
      at += character === '\r' && text[at + 1] === '\n' ? 2 : 1;
      append(at, false);
      continue;
    }
    // Periods within decimals, words and URLs are not sentence boundaries.
    const internalPeriod = character === '.' && /[a-z\d]/i.test(text[at - 1] ?? '')
      && /[a-z\d]/i.test(text[at + 1] ?? '');
    if (/[。！？.!?]/.test(character) && !internalPeriod) {
      let end = at + 1;
      while (end < text.length && /[。！？.!?]/.test(text[end])) end++;
      while (end < text.length && /["'”’」』》〉）)\]】]/.test(text[end])) end++;
      append(end, true);
      at = end;
      continue;
    }
    if (/\S/.test(character)) hasProse = true;
    at++;
  }
  append(text.length, false);
  return spans;
}

/** Locate <now_plot> / <gametxt> narrative bodies outside code and image regions. */
export function narrativeSpans(text: string, regions: readonly TextRegion[] = imageTextRegions(text)): NarrativeSpan[] {
  // HTML comments/scripts and code samples are opaque regions. Only standalone
  // tag regions can open/close a narrative body, including nested wrappers.
  const spans: NarrativeSpan[] = [];
  const stack: Array<{ tag: string; start: number }> = [];
  for (const region of regions) {
    if (region.kind !== 'html' || !region.closed) continue;
    const token = text.slice(region.start, region.end);
    const open = /^<(now_plot|gametxt)(?:\s[^<>]*)?>$/i.exec(token);
    if (open) { stack.push({ tag: open[1].toLowerCase(), start: region.end }); continue; }
    const close = /^<\/(now_plot|gametxt)\s*>$/i.exec(token);
    if (!close || !stack.length) continue;
    const current = stack.at(-1)!;
    if (current.tag !== close[1].toLowerCase()) { stack.length = 0; continue; }
    stack.pop();
    if (!stack.length && text.slice(current.start, region.start).trim()) {
      spans.push({ start: current.start, end: region.start });
    }
  }
  return spans;
}

export function createImageInsertionPlan(original: string, excludedTags: readonly string[] = []): ImageInsertionPlan {
  return insertionPlan(original, false, excludedTags);
}

/** Fine-grained positions are reserved for the manual picker; automatic placement stays line based. */
export function createSelectedImageInsertionPlan(original: string, excludedTags: readonly string[] = []): ImageInsertionPlan {
  return insertionPlan(original, true, excludedTags);
}

function insertionPlan(original: string, includeSentences: boolean, excludedTags: readonly string[]): ImageInsertionPlan {
  if (typeof original !== 'string' || original.length > MAX_ORIGINAL_LENGTH) throw withFault(new Error('这段正文太长或者格式不对，排不出来插入空位。'), 'format');
  const regions = imageTextRegions(original, excludedTags);
  const spans = narrativeSpans(original, regions);
  const bounds: NarrativeSpan[] = spans.length ? spans : [{ start: 0, end: original.length }];
  const offsets = new Set<number>();
  let regionIndex = 0;
  for (const span of bounds) {
    for (const line of textLines(original.slice(span.start, span.end))) {
      if (!original.slice(span.start + line.start, span.start + line.contentEnd).trim()) continue;
      const offset = span.start + line.end;
      while (regionIndex < regions.length && (regions[regionIndex].end < offset
        || (regions[regionIndex].end === offset && regions[regionIndex].closed))) regionIndex++;
      const region = regions[regionIndex];
      if (region && region.start < offset && (offset < region.end || !region.closed)) continue;
      offsets.add(offset);
    }
  }
  if (includeSentences) {
    let boundIndex = 0;
    for (const sentence of imageSentenceSpans(original, regions)) {
      if (!sentence.terminated || !sentence.hasProse) continue;
      while (boundIndex < bounds.length && bounds[boundIndex].end < sentence.end) boundIndex++;
      const bound = bounds[boundIndex];
      if (bound && sentence.end > bound.start && sentence.end <= bound.end) offsets.add(sentence.end);
    }
  }
  const usedIds = new Set(Array.from(original.matchAll(/【插入点 (P\d+)】/g), match => match[1]));
  let nextId = 1;
  const points = [...offsets].sort((left, right) => left - right).map(offset => {
    let id: string;
    do { id = `P${String(nextId++).padStart(3, '0')}`; } while (usedIds.has(id));
    return Object.freeze({ id, offset });
  });
  return annotateInsertionPoints(original, points);
}

function annotateInsertionPoints(original: string, points: readonly ImageInsertionPoint[]): ImageInsertionPlan {
  const eol = newline(original);
  const pieces: string[] = [];
  let cursor = 0;
  let length = original.length;
  for (const point of points) {
    const separator = point.offset > 0 && /[\r\n]/.test(original[point.offset - 1]) ? '' : eol;
    const annotation = `${separator}【插入点 ${point.id}】${eol}`;
    length += annotation.length;
    if (length > MAX_MARKER_TEXT_LENGTH) throw withFault(new Error('这一楼段落太碎、插入点太多，标完超出长度限制了。'), 'format');
    pieces.push(original.slice(cursor, point.offset), annotation);
    cursor = point.offset;
  }
  pieces.push(original.slice(cursor));
  return Object.freeze({ original, text: pieces.join(''), points: Object.freeze(points) });
}

/** Keep the full source, annotating only the positions explicitly selected by the user. */
export function selectImageInsertionPoints(plan: ImageInsertionPlan, pointIds: readonly string[]): ImageInsertionPlan {
  const selected = new Set(pointIds);
  if (!selected.size) throw withFault(new Error('至少挑一个想插图的位置吧。'), 'format');
  if (selected.size !== pointIds.length) throw withFault(new Error('同一个插入位置别重复选两次。'), 'format');
  const points = plan.points.filter(point => selected.has(point.id));
  if (points.length !== selected.size) throw withFault(new Error('刚才挑的位置失效了，重新打开“指定插图”再选一次吧。'), 'format');
  return annotateInsertionPoints(plan.original, points);
}

interface Insertion { offset: number; content: string; markers: ImageMarker[] }

export interface InsertedImageMarker extends ImageMarker {
  /** Insertion offset in plan.original, before any new markers were added. */
  sourceOffset: number;
}

export interface ImageInsertionResult {
  text: string;
  added: InsertedImageMarker[];
  warnings: string[];
}

export function applyImageInsertions(plan: ImageInsertionPlan, response: string, requiredItems?: readonly IllustrationItem[]): ImageInsertionResult {
  if (typeof response !== 'string' || response.length > MAX_MARKER_TEXT_LENGTH) throw withFault(new Error('AI 吐回来的内容太长或者格式不对劲。'), 'format');
  let source = response.trim();
  const fence = /^```(?:json)?[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)```$/i.exec(source);
  if (fence) source = fence[1];
  let decoded: unknown;
  try { decoded = JSON.parse(source); }
  catch { throw withFault(new Error('AI 得返回标准的配图 JSON 数组才行，楼层原文没动。'), 'format'); }
  if (!Array.isArray(decoded)) throw withFault(new Error('AI 需要返回 JSON 数组，不能自己把正文重写吐回来。'), 'format');
  const existing = parseImageMarkers(plan.original);
  if (decoded.length + existing.length > MAX_IMAGE_MARKERS) throw withFault(new Error('一楼里的配图加起来不能超过 64 处。'), 'format');
  const positions = new Map(plan.points.map(point => [point.id, point.offset]));
  const groups = new Map<number, { summary: string; prompt: string; size?: ImageSize }[]>();
  const itemByPoint = new Map<string, number>();
  requiredItems?.forEach((item, index) => {
    if (!item.pointIds.length) throw withFault(new Error('清单里有项没圈出位置，楼层原文没动。'), 'format');
    for (const id of item.pointIds) {
      if (!positions.has(id) || itemByPoint.has(id)) throw withFault(new Error('清单里有位置无效或者跟别的项撞重了，楼层原文没动。'), 'format');
      itemByPoint.set(id, index);
    }
  });
  const returnedItems = new Set<number>();
  const warnings: string[] = [];
  for (const row of decoded) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['at', 'summary', 'prompt', 'size'].includes(key)) || typeof row.at !== 'string'
      || typeof row.summary !== 'string' || typeof row.prompt !== 'string') {
      throw withFault(new Error('每项里面只能放 at、summary、prompt（顶多加个 size），别夹多余字段。'), 'format');
    }
    const offset = positions.get(row.at);
    const itemIndex = itemByPoint.get(row.at);
    if (offset === undefined || (requiredItems && itemIndex === undefined)) throw withFault(new Error(requiredItems
      ? 'AI 挑中了你没选过的插入点，这次没往里写，原文没动。' : 'AI 编了一个压根不存在的插入点，楼层原文没动。'), 'format');
    if (itemIndex !== undefined && returnedItems.has(itemIndex)) {
      throw withFault(new Error(`AI 给第 ${itemIndex + 1} 项塞了好几条配图，每项只能画一张，所以原文没动。`), 'format');
    }
    if (!row.summary.trim() || !row.prompt.trim() || /[\[\]<>\r\n]/.test(row.summary)
      || /<\s*\/?\s*img\b/i.test(row.prompt)) {
      throw withFault(new Error('配图的 summary 或 prompt 写岔了，不能为空，里面也不能再嵌图片标签。'), 'format');
    }
    const size = parseImageSize(row.size);
    if (Object.hasOwn(row, 'size') && !size) {
      warnings.push(`${row.at} 给的画幅不在那七种尺寸里，画的时候就按设置里的兜底画幅走。`);
    }
    const group = groups.get(offset) ?? [];
    group.push({ summary: row.summary, prompt: row.prompt, ...(size ? { size } : {}) });
    groups.set(offset, group);
    if (itemIndex !== undefined) returnedItems.add(itemIndex);
  }
  if (requiredItems && returnedItems.size !== requiredItems.length) {
    const missing = requiredItems.flatMap((_, index) => returnedItems.has(index) ? [] : [index + 1]);
    throw withFault(new Error(`AI 漏掉了清单里的第 ${missing.join('、')} 项，这次没保存，原文没动。`), 'format');
  }
  const eol = newline(plan.original);
  const insertions: Insertion[] = [];
  let totalLength = plan.original.length;
  for (const [offset, group] of groups) {
    const previousIsNewline = offset > 0 && /[\r\n]/.test(plan.original[offset - 1]);
    let content = previousIsNewline ? eol : eol + eol;
    const markers: ImageMarker[] = [];
    for (const item of group) {
      const metadata = item.size ? imageSizeMetadata(item.size) + eol : '';
      const raw = `<img>${eol}[${item.summary}]${eol}${metadata}${item.prompt}${eol}</img>`;
      markers.push({ start: content.length, end: content.length + raw.length, raw, summary: item.summary.trim(),
        prompt: item.prompt.trim(), ...(item.size ? { size: item.size } : {}) });
      content += raw + eol + eol;
    }
    totalLength += content.length;
    if (totalLength > MAX_MARKER_TEXT_LENGTH) throw withFault(new Error('把配图塞进去之后整楼超字数上限了，原文没动。'), 'format');
    insertions.push({ offset, content, markers });
  }
  // Validate every row before constructing the new text; original slices are never rewritten.
  insertions.sort((a, b) => b.offset - a.offset);
  let text = plan.original;
  for (const insertion of insertions) text = text.slice(0, insertion.offset) + insertion.content + text.slice(insertion.offset);
  let shift = 0;
  const added: InsertedImageMarker[] = [];
  for (const insertion of [...insertions].reverse()) {
    for (const marker of insertion.markers) {
      added.push({
        ...marker, start: marker.start + insertion.offset + shift, end: marker.end + insertion.offset + shift,
        sourceOffset: insertion.offset,
      });
    }
    shift += insertion.content.length;
  }
  const parsed = new Map(parseImageMarkers(text).map(marker => [marker.start, marker]));
  if (added.some(marker => parsed.get(marker.start)?.raw !== marker.raw)) throw withFault(new Error('配图标记写进去之后跟原正文粘连破损了，已撤回，原文没动。'), 'format');
  return { text, added, warnings };
}
