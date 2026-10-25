import { MAX_IMAGE_MARKERS, MAX_MARKER_TEXT_LENGTH, MAX_ORIGINAL_LENGTH, parseImageMarkers } from './image-markers.js';
import { imageTextRegions, textLines } from './image-text-regions.js';
function newline(text) { return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n'; }
/** Locate <now_plot> / <gametxt> narrative bodies outside code and image regions. */
export function narrativeSpans(text, regions = imageTextRegions(text)) {
    // HTML comments/scripts and code samples are opaque regions. Only standalone
    // tag regions can open/close a narrative body, including nested wrappers.
    const spans = [];
    const stack = [];
    for (const region of regions) {
        if (region.kind !== 'html' || !region.closed)
            continue;
        const token = text.slice(region.start, region.end);
        const open = /^<(now_plot|gametxt)(?:\s[^<>]*)?>$/i.exec(token);
        if (open) {
            stack.push({ tag: open[1].toLowerCase(), start: region.end });
            continue;
        }
        const close = /^<\/(now_plot|gametxt)\s*>$/i.exec(token);
        if (!close || !stack.length)
            continue;
        const current = stack.at(-1);
        if (current.tag !== close[1].toLowerCase()) {
            stack.length = 0;
            continue;
        }
        stack.pop();
        if (!stack.length && text.slice(current.start, region.start).trim()) {
            spans.push({ start: current.start, end: region.start });
        }
    }
    return spans;
}
export function createImageInsertionPlan(original) {
    if (typeof original !== 'string' || original.length > MAX_ORIGINAL_LENGTH)
        throw new Error('正文过长或格式无效，无法建立插入位置。');
    const regions = imageTextRegions(original);
    const spans = narrativeSpans(original, regions);
    const bounds = spans.length ? spans : [{ start: 0, end: original.length }];
    const usedIds = new Set(Array.from(original.matchAll(/【插入点 (P\d+)】/g), match => match[1]));
    const points = [];
    let regionIndex = 0;
    let nextId = 1;
    for (const span of bounds) {
        for (const line of textLines(original.slice(span.start, span.end))) {
            if (!original.slice(span.start + line.start, span.start + line.contentEnd).trim())
                continue;
            const offset = span.start + line.end;
            while (regionIndex < regions.length && (regions[regionIndex].end < offset
                || (regions[regionIndex].end === offset && regions[regionIndex].closed)))
                regionIndex++;
            const region = regions[regionIndex];
            if (region && region.start < offset && (offset < region.end || !region.closed))
                continue;
            if (points.at(-1)?.offset === offset)
                continue;
            let id;
            do {
                id = `P${String(nextId++).padStart(3, '0')}`;
            } while (usedIds.has(id));
            points.push(Object.freeze({ id, offset }));
        }
    }
    const eol = newline(original);
    const pieces = [];
    let cursor = 0;
    let length = original.length;
    for (const point of points) {
        const separator = point.offset > 0 && /[\r\n]/.test(original[point.offset - 1]) ? '' : eol;
        const annotation = `${separator}【插入点 ${point.id}】${eol}`;
        length += annotation.length;
        if (length > MAX_MARKER_TEXT_LENGTH)
            throw new Error('正文可插入位置过多，标注后超过长度限制。');
        pieces.push(original.slice(cursor, point.offset), annotation);
        cursor = point.offset;
    }
    pieces.push(original.slice(cursor));
    return Object.freeze({ original, text: pieces.join(''), points: Object.freeze(points) });
}
export function applyImageInsertions(plan, response) {
    if (typeof response !== 'string' || response.length > MAX_MARKER_TEXT_LENGTH)
        throw new Error('AI 返回内容过长或格式无效。');
    let source = response.trim();
    const fence = /^```(?:json)?[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)```$/i.exec(source);
    if (fence)
        source = fence[1];
    let decoded;
    try {
        decoded = JSON.parse(source);
    }
    catch {
        throw new Error('AI 需要返回配图 JSON 数组，原文未修改。');
    }
    if (!Array.isArray(decoded))
        throw new Error('AI 需要返回配图 JSON 数组，不能返回改写后的正文。');
    const existing = parseImageMarkers(plan.original);
    if (decoded.length + existing.length > MAX_IMAGE_MARKERS)
        throw new Error('图片标记总数不能超过 64 处。');
    const positions = new Map(plan.points.map(point => [point.id, point.offset]));
    const groups = new Map();
    for (const row of decoded) {
        if (!row || typeof row !== 'object' || Array.isArray(row)
            || Object.keys(row).length !== 3 || typeof row.at !== 'string'
            || typeof row.summary !== 'string' || typeof row.prompt !== 'string') {
            throw new Error('每处配图只能包含 at、summary、prompt 三项。');
        }
        const offset = positions.get(row.at);
        if (offset === undefined)
            throw new Error('AI 返回了不存在的插入点，原文未修改。');
        if (!row.summary.trim() || !row.prompt.trim() || /[\[\]<>\r\n]/.test(row.summary)
            || /<\s*\/?\s*img\b/i.test(row.prompt)) {
            throw new Error('配图概括或提示词无效，不能为空或嵌入图片标记。');
        }
        const group = groups.get(offset) ?? [];
        group.push({ summary: row.summary, prompt: row.prompt });
        groups.set(offset, group);
    }
    const eol = newline(plan.original);
    const insertions = [];
    let totalLength = plan.original.length;
    for (const [offset, group] of groups) {
        const previousIsNewline = offset > 0 && /[\r\n]/.test(plan.original[offset - 1]);
        let content = previousIsNewline ? eol : eol + eol;
        const markers = [];
        for (const item of group) {
            const raw = `<img>${eol}[${item.summary}]${eol}${item.prompt}${eol}</img>`;
            markers.push({ start: content.length, end: content.length + raw.length, raw, summary: item.summary.trim(), prompt: item.prompt.trim() });
            content += raw + eol + eol;
        }
        totalLength += content.length;
        if (totalLength > MAX_MARKER_TEXT_LENGTH)
            throw new Error('插入后的正文超过长度限制，原文未修改。');
        insertions.push({ offset, content, markers });
    }
    // Validate every row before constructing the new text; original slices are never rewritten.
    insertions.sort((a, b) => b.offset - a.offset);
    let text = plan.original;
    for (const insertion of insertions)
        text = text.slice(0, insertion.offset) + insertion.content + text.slice(insertion.offset);
    let shift = 0;
    const added = [];
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
    if (added.some(marker => parsed.get(marker.start)?.raw !== marker.raw))
        throw new Error('配图未能形成独立的完整标记，原文未修改。');
    return { text, added };
}
