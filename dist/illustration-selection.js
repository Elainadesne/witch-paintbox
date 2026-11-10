import { imageSentenceSpans } from './image-insertion.js';
import { imageTextRegions, textLines } from './image-text-regions.js';
import { MAX_IMAGE_MARKERS, parseImageMarkers } from './image-markers.js';
import { withFault } from './pet-events.js';
function paragraphSpans(text, linesPerParagraph) {
    const spans = [];
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
        }
        else if (nonempty) {
            if (separated) {
                spans.push({ start, end: line.start });
                start = line.start;
            }
            count++;
            separated = false;
        }
        else if (count)
            separated = true;
    }
    if (start < text.length)
        spans.push({ start, end: text.length });
    return spans;
}
function hasProse(text, span, regions) {
    let low = 0;
    let high = regions.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (regions[middle].end <= span.start)
            low = middle + 1;
        else
            high = middle;
    }
    let cursor = span.start;
    for (let index = low; index < regions.length && regions[index].start < span.end; index++) {
        const region = regions[index];
        if (text.slice(cursor, Math.min(region.start, span.end)).trim())
            return true;
        cursor = Math.max(cursor, region.end);
        if (cursor >= span.end)
            return false;
    }
    return Boolean(text.slice(cursor, span.end).trim());
}
/** All units retain their exact source slices; unselectable markup and code remain visible. */
export function buildIllustrationUnits(plan, mode, linesPerParagraph = 3, excludedTags = []) {
    const original = plan.original;
    const regions = imageTextRegions(original, excludedTags);
    const sentences = mode === 'sentence' ? imageSentenceSpans(original, regions) : null;
    const rawSpans = mode === 'manual' ? textLines(original) : sentences ?? paragraphSpans(original, mode === 'lines'
        ? [3, 5, 8].includes(linesPerParagraph) ? linesPerParagraph : 3 : undefined);
    // Excluded blocks (think, UpdateVariable…) always stand alone, even without a blank line around them.
    const cuts = mode === 'manual' ? [] : regions.filter(region => region.excluded).flatMap(region => [region.start, region.end]);
    const spans = cuts.length ? rawSpans.flatMap(span => {
        const inside = cuts.filter(cut => cut > span.start && cut < span.end);
        if (!inside.length)
            return [span];
        const edges = [span.start, ...inside, span.end];
        return edges.slice(1).map((end, index) => ({ start: edges[index], end }));
    }) : rawSpans;
    const byOffset = new Map(plan.points.map(point => [point.offset, point.id]));
    const units = [];
    let pointIndex = 0;
    let leadingStart;
    for (const span of spans) {
        const text = original.slice(span.start, span.end);
        if (!text.trim() && mode !== 'manual') {
            if (units.length)
                units[units.length - 1].end = span.end;
            else
                leadingStart ??= span.start;
            continue;
        }
        const pointIds = [];
        if (mode === 'sentence') {
            // Punctuation ends at its own offset, including closing quotes. A fragment
            // may only reuse a line-end position that already exists at its exact end.
            const id = byOffset.get(span.end);
            if (id && hasProse(original, span, regions))
                pointIds.push(id);
        }
        else {
            while (pointIndex < plan.points.length && plan.points[pointIndex].offset <= span.start)
                pointIndex++;
            let index = pointIndex;
            while (index < plan.points.length && plan.points[index].offset <= span.end) {
                pointIds.push(plan.points[index++].id);
            }
            pointIndex = index;
            if (!hasProse(original, span, regions))
                pointIds.length = 0;
        }
        units.push({ start: leadingStart ?? span.start, end: span.end, pointIds: Object.freeze(pointIds) });
        leadingStart = undefined;
    }
    if (!units.length && original.length)
        units.push({ start: 0, end: original.length, pointIds: Object.freeze([]) });
    const lines = textLines(original);
    const lineAt = (offset) => {
        let low = 0;
        let high = lines.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (lines[middle].start <= offset)
                low = middle + 1;
            else
                high = middle;
        }
        return Math.max(1, low);
    };
    const barriers = mode === 'manual' ? regions.filter(region => region.kind !== 'html' || region.excluded || region.opaque || !region.closed) : [];
    let barrierIndex = 0;
    return Object.freeze(units.map(unit => {
        const text = original.slice(unit.start, unit.end);
        while (barrierIndex < barriers.length && barriers[barrierIndex].end <= unit.start)
            barrierIndex++;
        const blocked = barrierIndex < barriers.length && barriers[barrierIndex].start < unit.end;
        const first = text.length - text.trimStart().length;
        const last = Math.max(first, text.trimEnd().length - 1);
        const from = unit.start + first, to = unit.start + last + 1;
        const block = regions.find(region => region.excluded && region.start <= from && to <= region.end);
        return Object.freeze({ ...unit, id: `${mode}:${unit.start}:${unit.end}`, text,
            ...(blocked ? { blocked: true, pointIds: Object.freeze([]) } : {}),
            lineStart: lineAt(mode === 'manual' ? unit.start : from),
            lineEnd: lineAt(mode === 'manual' ? Math.max(unit.start, unit.end - 1) : unit.start + last),
            ...(block ? { excluded: block.excluded } : {}) });
    }));
}
/** Build one image request from consecutive source rows, never from rendered wrapping. */
export function groupIllustrationLines(plan, units, first, last) {
    const startIndex = Math.min(first, last), endIndex = Math.max(first, last);
    if (!Number.isInteger(first) || !Number.isInteger(last) || startIndex < 0 || endIndex >= units.length
        || !units[first]?.pointIds.length || !units[last]?.pointIds.length) {
        throw withFault(new Error('请选择有正文和可用插入点的首尾行。'), 'format');
    }
    const selected = units.slice(startIndex, endIndex + 1);
    if (selected.some(unit => unit.blocked)) {
        throw withFault(new Error('所选范围跨过了代码、已有配图或排除内容，请分开选择。'), 'format');
    }
    const from = selected[0], to = selected.at(-1);
    const pointIds = Object.freeze(selected.flatMap(unit => [...unit.pointIds]));
    return Object.freeze({ id: `manual:${from.start}:${to.end}`, start: from.start, end: to.end,
        text: plan.original.slice(from.start, to.end), lineStart: from.lineStart, lineEnd: to.lineEnd, pointIds });
}
/** Validate the entire list before a request, preserving its order and sorting each range by source offset. */
export function normalizeIllustrationItems(plan, items) {
    if (!Array.isArray(items) || !items.length)
        throw withFault(new Error('请至少加入一项指定插图。'), 'format');
    if (items.length + parseImageMarkers(plan.original).length > MAX_IMAGE_MARKERS) {
        throw withFault(new Error('指定插图清单与已有图片标记合计不能超过 64 处。'), 'format');
    }
    const offsets = new Map(plan.points.map(point => [point.id, point.offset]));
    const ranges = [];
    const normalized = items.map((item, index) => {
        if (!item || !Array.isArray(item.pointIds) || !item.pointIds.length) {
            throw withFault(new Error(`配图 ${index + 1} 没有可用插入点，请重新选择。`), 'format');
        }
        const selected = item.pointIds;
        const unique = new Set(selected);
        if (unique.size !== selected.length || selected.some(id => !offsets.has(id))) {
            throw withFault(new Error(`配图 ${index + 1} 的插入点无效或重复，请重新选择。`), 'format');
        }
        const pointIds = [...selected].sort((left, right) => offsets.get(left) - offsets.get(right));
        ranges.push({ start: offsets.get(pointIds[0]), end: offsets.get(pointIds[pointIds.length - 1]), index });
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
