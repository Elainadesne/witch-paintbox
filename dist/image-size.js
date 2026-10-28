export const IMAGE_SIZES = [
    '832x1216', '1216x832', '1024x1024', '768x1344', '1344x768', '896x1152', '1152x896',
];
export function parseImageSize(value) {
    if (typeof value !== 'string')
        return undefined;
    const size = value.trim();
    return IMAGE_SIZES.find(candidate => candidate === size);
}
export function imageSizeDimensions(size) {
    const [width, height] = size.split('x').map(Number);
    return { width, height };
}
export function imageSizeMetadata(size) {
    return `<!-- witch-paintbox:size=${size} -->`;
}
/** Reserved metadata occupies its own first line after the marker summary. */
export function readImageSizeMetadata(text) {
    const body = text.trim();
    const match = /^[ \t]*<!--[ \t]*witch-paintbox:size=([^<>\r\n]*?)[ \t]*-->[ \t]*(?:\r\n|\r|\n|$)/.exec(body);
    if (!match)
        return { prompt: body };
    const size = parseImageSize(match[1]);
    return { prompt: body.slice(match[0].length).trim(), ...(size ? { size } : {}) };
}
/** HTML renderers can remove this comment, so DOM matching also needs a clean variant. */
export function stripImageSizeMetadata(text) {
    return text.replace(/(^|\r\n|\r|\n)[ \t]*<!--[ \t]*witch-paintbox:size=[^<>\r\n]*?-->[ \t]*(?:\r\n|\r|\n|$)/g, '$1');
}
