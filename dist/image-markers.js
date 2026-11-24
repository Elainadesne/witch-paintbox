import { imageTextRegions } from './image-text-regions.js';
import { readImageSizeMetadata } from './image-size.js';
export const MAX_ORIGINAL_LENGTH = 256 * 1024;
export const MAX_MARKER_TEXT_LENGTH = 512 * 1024;
export const MAX_IMAGE_MARKERS = 64;
/** Only complete literal markers outside code and HTML declarations are executable. */
export function parseImageMarkers(text) {
    if (typeof text !== 'string' || text.length > MAX_MARKER_TEXT_LENGTH)
        throw new Error('这段正文太长或者格式不对，解析不出配图标记。');
    const markers = [];
    for (const region of imageTextRegions(text)) {
        if (region.kind !== 'image' || !region.closed || region.nested)
            continue;
        const raw = text.slice(region.start, region.end);
        const parts = /^<img>(?:\r\n|\r|\n)\[([^\[\]<>\r\n]+)\](?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)<\/img>$/.exec(raw);
        if (!parts || !parts[1].trim() || !parts[2].trim() || /<\/?\s*img\b/i.test(parts[2]))
            continue;
        const metadata = readImageSizeMetadata(parts[2]);
        if (!metadata.prompt)
            continue;
        markers.push({ start: region.start, end: region.end, raw, summary: parts[1].trim(), ...metadata });
        if (markers.length > MAX_IMAGE_MARKERS)
            throw new Error('一楼里最多只能留 64 处配图标记。');
    }
    return markers;
}
