import { imageTextRegions } from './image-text-regions.js';
export const MAX_ORIGINAL_LENGTH = 256 * 1024;
export const MAX_MARKER_TEXT_LENGTH = 512 * 1024;
export const MAX_IMAGE_MARKERS = 64;
/** Only complete literal markers outside code and HTML declarations are executable. */
export function parseImageMarkers(text) {
    if (typeof text !== 'string' || text.length > MAX_MARKER_TEXT_LENGTH)
        throw new Error('图片标记正文过长或格式无效。');
    const markers = [];
    for (const region of imageTextRegions(text)) {
        if (region.kind !== 'image' || !region.closed || region.nested)
            continue;
        const raw = text.slice(region.start, region.end);
        const parts = /^<img>(?:\r\n|\r|\n)\[([^\[\]<>\r\n]+)\](?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)<\/img>$/.exec(raw);
        if (!parts || !parts[1].trim() || !parts[2].trim() || /<\/?\s*img\b/i.test(parts[2]))
            continue;
        markers.push({ start: region.start, end: region.end, raw, summary: parts[1].trim(), prompt: parts[2].trim() });
        if (markers.length > MAX_IMAGE_MARKERS)
            throw new Error('图片标记最多保留 64 处。');
    }
    return markers;
}
