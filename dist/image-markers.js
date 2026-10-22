const maxOriginalLength = 256 * 1024;
const maxTextLength = 512 * 1024;
const maxMarkers = 64;
function codeFences(text) {
    const ranges = [];
    let fence = null;
    const lines = /[^\n]*(?:\n|$)/g;
    for (const match of text.matchAll(lines)) {
        if (!match[0])
            continue;
        const line = match[0].replace(/\r?\n$/, '');
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (!delimiter)
            continue;
        if (!fence) {
            fence = { character: delimiter[1][0], length: delimiter[1].length, start: match.index };
        }
        else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
            ranges.push({ start: fence.start, end: match.index + match[0].length });
            fence = null;
        }
    }
    if (fence)
        ranges.push({ start: fence.start, end: text.length });
    return ranges;
}
/** These markers are literal text, never HTML. Fenced examples are ignored. */
export function parseImageMarkers(text) {
    if (typeof text !== 'string' || text.length > maxTextLength)
        throw new Error('图片标记正文过长或格式无效。');
    const fences = codeFences(text);
    const markers = [];
    let fenceIndex = 0;
    let depth = 0;
    let start = 0;
    let nested = false;
    let crossedFence = false;
    for (const token of text.matchAll(/<\/?img>/g)) {
        while (fenceIndex < fences.length && fences[fenceIndex].end <= token.index) {
            if (depth && fences[fenceIndex].start >= start)
                crossedFence = true;
            fenceIndex++;
        }
        if (fenceIndex < fences.length && fences[fenceIndex].start <= token.index) {
            if (depth)
                crossedFence = true;
            continue;
        }
        if (token[0] === '<img>') {
            if (depth === 0) {
                start = token.index;
                nested = false;
                crossedFence = false;
            }
            else
                nested = true;
            depth++;
            continue;
        }
        if (!depth || --depth !== 0 || nested || crossedFence)
            continue;
        const end = token.index + token[0].length;
        const raw = text.slice(start, end);
        const parts = /^<img>\r?\n\[([^\[\]<>\r\n]+)\]\r?\n([\s\S]*?)\r?\n<\/img>$/.exec(raw);
        if (!parts || !parts[1].trim() || !parts[2].trim() || /<\/?img\b/i.test(parts[2]))
            continue;
        markers.push({ start, end, raw, summary: parts[1].trim(), prompt: parts[2].trim() });
        if (markers.length > maxMarkers)
            throw new Error('图片标记最多保留 64 处。');
    }
    return markers;
}
/** Exact substring matches at every source offset, computed in linear time. */
function matchingOffsets(source, pattern) {
    const matches = new Uint8Array(source.length + 1);
    if (!pattern.length) {
        matches.fill(1);
        return matches;
    }
    if (pattern.length > source.length)
        return matches;
    const prefix = new Uint32Array(pattern.length);
    for (let i = 1, length = 0; i < pattern.length; i++) {
        while (length && pattern[i] !== pattern[length])
            length = prefix[length - 1];
        if (pattern[i] === pattern[length])
            length++;
        prefix[i] = length;
    }
    for (let i = 0, length = 0; i < source.length; i++) {
        while (length && source[i] !== pattern[length])
            length = prefix[length - 1];
        if (source[i] === pattern[length])
            length++;
        if (length === pattern.length) {
            matches[i - pattern.length + 1] = 1;
            length = prefix[length - 1];
        }
    }
    return matches;
}
function invalidInsertion() {
    throw new Error('返回内容改动了原文，或包含不完整、嵌套的图片标记。');
}
/** Accept only exact original text plus whole new markers outside existing markers. */
export function validateImageInsertions(original, candidate) {
    if (typeof original !== 'string' || typeof candidate !== 'string'
        || original.length > maxOriginalLength || candidate.length > maxTextLength) {
        throw new Error('正文过长或格式无效，无法校验图片标记。');
    }
    if (candidate.length < original.length)
        invalidInsertion();
    const existing = parseImageMarkers(original);
    const markers = parseImageMarkers(candidate);
    const protectedOffsets = new Uint8Array(original.length + 1);
    for (const marker of existing)
        protectedOffsets.fill(1, marker.start + 1, marker.end);
    // Equal source offsets have identical future possibilities; keep one valid history.
    let states = new Map([[0, 0n]]);
    const consume = (literal) => {
        if (!literal.length)
            return;
        const matches = states.size > 1 ? matchingOffsets(original, literal) : null;
        const next = new Map();
        for (const [offset, added] of states) {
            if (matches ? matches[offset] : original.startsWith(literal, offset)) {
                next.set(offset + literal.length, added);
            }
        }
        states = next;
        if (!states.size)
            invalidInsertion();
    };
    let cursor = 0;
    for (let index = 0; index < markers.length; index++) {
        const marker = markers[index];
        consume(candidate.slice(cursor, marker.start));
        const matches = states.size > 1 ? matchingOffsets(original, marker.raw) : null;
        const next = new Map();
        for (const [offset, added] of states) {
            if (!protectedOffsets[offset])
                next.set(offset, added | (1n << BigInt(index)));
            if (matches ? matches[offset] : original.startsWith(marker.raw, offset)) {
                next.set(offset + marker.raw.length, added);
            }
        }
        states = next;
        if (!states.size)
            invalidInsertion();
        cursor = marker.end;
    }
    consume(candidate.slice(cursor));
    const added = states.get(original.length);
    if (added === undefined)
        invalidInsertion();
    return { text: candidate, added: markers.filter((_, index) => (added & (1n << BigInt(index))) !== 0n) };
}
