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

export function createImageInsertionPlan(original: string): ImageInsertionPlan {
  return insertionPlan(original, false);
}

/** Fine-grained positions are reserved for the manual picker; automatic placement stays line based. */
export function createSelectedImageInsertionPlan(original: string): ImageInsertionPlan {
  return insertionPlan(original, true);
}

function insertionPlan(original: string, includeSentences: boolean): ImageInsertionPlan {
  if (typeof original !== 'string' || original.length > MAX_ORIGINAL_LENGTH) throw withFault(new Error('正文过长或格式无效，无法建立插入位置。'), 'format');
  const regions = imageTextRegions(original);
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
    if (length > MAX_MARKER_TEXT_LENGTH) throw withFault(new Error('正文可插入位置过多，标注后超过长度限制。'), 'format');
    pieces.push(original.slice(cursor, point.offset), annotation);
    cursor = point.offset;
  }
  pieces.push(original.slice(cursor));
  return Object.freeze({ original, text: pieces.join(''), points: Object.freeze(points) });
}

/** Keep the full source, annotating only the positions explicitly selected by the user. */
export function selectImageInsertionPoints(plan: ImageInsertionPlan, pointIds: readonly string[]): ImageInsertionPlan {
  const selected = new Set(pointIds);
  if (!selected.size) throw withFault(new Error('请至少选择一处插图位置。'), 'format');
  if (selected.size !== pointIds.length) throw withFault(new Error('同一个插图位置不能重复选择。'), 'format');
  const points = plan.points.filter(point => selected.has(point.id));
  if (points.length !== selected.size) throw withFault(new Error('所选插图位置已失效，请重新打开指定插图。'), 'format');
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
  if (typeof response !== 'string' || response.length > MAX_MARKER_TEXT_LENGTH) throw withFault(new Error('AI 返回内容过长或格式无效。'), 'format');
  let source = response.trim();
  const fence = /^```(?:json)?[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)```$/i.exec(source);
  if (fence) source = fence[1];
  let decoded: unknown;
  try { decoded = JSON.parse(source); }
  catch { throw withFault(new Error('AI 需要返回配图 JSON 数组，原文未修改。'), 'format'); }
  if (!Array.isArray(decoded)) throw withFault(new Error('AI 需要返回配图 JSON 数组，不能返回改写后的正文。'), 'format');
  const existing = parseImageMarkers(plan.original);
  if (decoded.length + existing.length > MAX_IMAGE_MARKERS) throw withFault(new Error('图片标记总数不能超过 64 处。'), 'format');
  const positions = new Map(plan.points.map(point => [point.id, point.offset]));
  const groups = new Map<number, { summary: string; prompt: string; size?: ImageSize }[]>();
  const itemByPoint = new Map<string, number>();
  requiredItems?.forEach((item, index) => {
    if (!item.pointIds.length) throw withFault(new Error('指定插图清单存在空项，原文未修改。'), 'format');
    for (const id of item.pointIds) {
      if (!positions.has(id) || itemByPoint.has(id)) throw withFault(new Error('指定插图清单的位置无效或重叠，原文未修改。'), 'format');
      itemByPoint.set(id, index);
    }
  });
  const returnedItems = new Set<number>();
  const warnings: string[] = [];
  for (const row of decoded) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['at', 'summary', 'prompt', 'size'].includes(key)) || typeof row.at !== 'string'
      || typeof row.summary !== 'string' || typeof row.prompt !== 'string') {
      throw withFault(new Error('每处配图需包含 at、summary、prompt，可选 size；不能包含其他字段。'), 'format');
    }
    const offset = positions.get(row.at);
    const itemIndex = itemByPoint.get(row.at);
    if (offset === undefined || (requiredItems && itemIndex === undefined)) throw withFault(new Error(requiredItems
      ? 'AI 返回了未选择的插入点，原文未修改。' : 'AI 返回了不存在的插入点，原文未修改。'), 'format');
    if (itemIndex !== undefined && returnedItems.has(itemIndex)) {
      throw withFault(new Error(`AI 为配图 ${itemIndex + 1} 返回了多条数据，每项只能生成一张，原文未修改。`), 'format');
    }
    if (!row.summary.trim() || !row.prompt.trim() || /[\[\]<>\r\n]/.test(row.summary)
      || /<\s*\/?\s*img\b/i.test(row.prompt)) {
      throw withFault(new Error('配图概括或提示词无效，不能为空或嵌入图片标记。'), 'format');
    }
    const size = parseImageSize(row.size);
    if (Object.hasOwn(row, 'size') && !size) {
      warnings.push(`${row.at} 的画幅不在支持的七种尺寸中，将使用设置中的画幅。`);
    }
    const group = groups.get(offset) ?? [];
    group.push({ summary: row.summary, prompt: row.prompt, ...(size ? { size } : {}) });
    groups.set(offset, group);
    if (itemIndex !== undefined) returnedItems.add(itemIndex);
  }
  if (requiredItems && returnedItems.size !== requiredItems.length) {
    const missing = requiredItems.flatMap((_, index) => returnedItems.has(index) ? [] : [index + 1]);
    throw withFault(new Error(`AI 遗漏了清单中的配图 ${missing.join('、')}，原文未修改。`), 'format');
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
    if (totalLength > MAX_MARKER_TEXT_LENGTH) throw withFault(new Error('插入后的正文超过长度限制，原文未修改。'), 'format');
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
  if (added.some(marker => parsed.get(marker.start)?.raw !== marker.raw)) throw withFault(new Error('配图未能形成独立的完整标记，原文未修改。'), 'format');
  return { text, added, warnings };
}
