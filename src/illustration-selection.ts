import { imageSentenceSpans, type ImageInsertionPlan } from './image-insertion.js';
import { imageTextRegions, textLines, type TextRegion } from './image-text-regions.js';
import { MAX_IMAGE_MARKERS, parseImageMarkers } from './image-markers.js';
import { withFault } from './pet-events.js';

export type IllustrationSelectionMode = 'paragraph' | 'lines' | 'sentence';

/** A shopping-list item requests one image, chosen from its allowed positions. */
export interface IllustrationItem {
  readonly pointIds: readonly string[];
}

export interface IllustrationUnit extends IllustrationItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Set when the unit lies entirely inside an excluded tag block. */
  readonly excluded?: string;
}

interface Span { start: number; end: number }

function paragraphSpans(text: string, linesPerParagraph?: number): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let count = 0;
  let separated = false;
  for (const line of textLines(text)) {
    const nonempty = Boolean(text.slice(line.start, line.contentEnd).trim());
    if (linesPerParagraph) {
      if (nonempty && ++count === linesPerParagraph) {
        spans.push({ start, end: line.end });
        start = line.end;
        count = 0;
      }
    } else if (nonempty) {
      if (separated) { spans.push({ start, end: line.start }); start = line.start; }
      count++;
      separated = false;
    } else if (count) separated = true;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

function hasProse(text: string, span: Span, regions: readonly TextRegion[]): boolean {
  let low = 0;
  let high = regions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (regions[middle].end <= span.start) low = middle + 1;
    else high = middle;
  }
  let cursor = span.start;
  for (let index = low; index < regions.length && regions[index].start < span.end; index++) {
    const region = regions[index];
    if (text.slice(cursor, Math.min(region.start, span.end)).trim()) return true;
    cursor = Math.max(cursor, region.end);
    if (cursor >= span.end) return false;
  }
  return Boolean(text.slice(cursor, span.end).trim());
}

/** All units retain their exact source slices; unselectable markup and code remain visible. */
export function buildIllustrationUnits(plan: ImageInsertionPlan, mode: IllustrationSelectionMode,
  linesPerParagraph = 3, excludedTags: readonly string[] = []): readonly IllustrationUnit[] {
  const original = plan.original;
  const regions = imageTextRegions(original, excludedTags);
  const sentences = mode === 'sentence' ? imageSentenceSpans(original, regions) : null;
  const rawSpans: Span[] = sentences ?? paragraphSpans(original, mode === 'lines'
    ? [3, 5, 8].includes(linesPerParagraph) ? linesPerParagraph : 3 : undefined);
  // Excluded blocks (think, UpdateVariable…) always stand alone, even without a blank line around them.
  const cuts = regions.filter(region => region.excluded).flatMap(region => [region.start, region.end]);
  const spans: Span[] = cuts.length ? rawSpans.flatMap(span => {
    const inside = cuts.filter(cut => cut > span.start && cut < span.end);
    if (!inside.length) return [span];
    const edges = [span.start, ...inside, span.end];
    return edges.slice(1).map((end, index) => ({ start: edges[index], end }));
  }) : rawSpans;
  const byOffset = new Map(plan.points.map(point => [point.offset, point.id]));
  const units: Array<Span & IllustrationItem> = [];
  let pointIndex = 0;
  let leadingStart: number | undefined;
  for (const span of spans) {
    const text = original.slice(span.start, span.end);
    if (!text.trim()) {
      if (units.length) units[units.length - 1].end = span.end;
      else leadingStart ??= span.start;
      continue;
    }
    const pointIds: string[] = [];
    if (mode === 'sentence') {
      // Punctuation ends at its own offset, including closing quotes. A fragment
      // may only reuse a line-end position that already exists at its exact end.
      const id = byOffset.get(span.end);
      if (id && hasProse(original, span, regions)) pointIds.push(id);
    } else {
      while (pointIndex < plan.points.length && plan.points[pointIndex].offset <= span.start) pointIndex++;
      let index = pointIndex;
      while (index < plan.points.length && plan.points[index].offset <= span.end) {
        pointIds.push(plan.points[index++].id);
      }
      pointIndex = index;
      if (!hasProse(original, span, regions)) pointIds.length = 0;
    }
    units.push({ start: leadingStart ?? span.start, end: span.end, pointIds: Object.freeze(pointIds) });
    leadingStart = undefined;
  }
  if (!units.length && original.length) units.push({ start: 0, end: original.length, pointIds: Object.freeze([]) });
  const lines = textLines(original);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle].start <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
  return Object.freeze(units.map(unit => {
    const text = original.slice(unit.start, unit.end);
    const first = text.length - text.trimStart().length;
    const last = Math.max(first, text.trimEnd().length - 1);
    const from = unit.start + first, to = unit.start + last + 1;
    const block = regions.find(region => region.excluded && region.start <= from && to <= region.end);
    return Object.freeze({ ...unit, id: `${mode}:${unit.start}:${unit.end}`, text,
      lineStart: lineAt(from), lineEnd: lineAt(unit.start + last), ...(block ? { excluded: block.excluded } : {}) });
  }));
}

/** Validate the entire list before a request, preserving its order and sorting each range by source offset. */
export function normalizeIllustrationItems(plan: ImageInsertionPlan, items: readonly IllustrationItem[]): readonly IllustrationItem[] {
  if (!Array.isArray(items) || !items.length) throw withFault(new Error('请至少加入一项指定插图。'), 'format');
  if (items.length + parseImageMarkers(plan.original).length > MAX_IMAGE_MARKERS) {
    throw withFault(new Error('指定插图清单与已有图片标记合计不能超过 64 处。'), 'format');
  }
  const offsets = new Map(plan.points.map(point => [point.id, point.offset]));
  const ranges: Array<Span & { index: number }> = [];
  const normalized = items.map((item, index) => {
    if (!item || !Array.isArray(item.pointIds) || !item.pointIds.length) {
      throw withFault(new Error(`配图 ${index + 1} 没有可用插入点，请重新选择。`), 'format');
    }
    const selected: readonly string[] = item.pointIds;
    const unique = new Set(selected);
    if (unique.size !== selected.length || selected.some(id => !offsets.has(id))) {
      throw withFault(new Error(`配图 ${index + 1} 的插入点无效或重复，请重新选择。`), 'format');
    }
    const pointIds = [...selected].sort((left, right) => offsets.get(left)! - offsets.get(right)!);
    ranges.push({ start: offsets.get(pointIds[0])!, end: offsets.get(pointIds[pointIds.length - 1])!, index });
    return Object.freeze({ pointIds: Object.freeze(pointIds) });
  });
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start <= ranges[index - 1].end) {
      throw withFault(new Error(`配图 ${ranges[index - 1].index + 1} 与配图 ${ranges[index].index + 1} 的位置重叠，请移除重复项。`), 'format');
    }
  }
  return Object.freeze(normalized);
}
