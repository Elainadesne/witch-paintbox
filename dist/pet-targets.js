/** A frame the host draws (Sifang), from its reported box; null for a box that is not one. */
export function nativeTarget(box) {
    const numbers = [box.left, box.top, box.width, box.height];
    if (!numbers.every(Number.isFinite) || box.width <= 0 || box.height <= 0)
        return null;
    const v = box.view;
    const view = v && [v.left, v.top, v.right, v.bottom].every(Number.isFinite) ? v : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const rect = new DOMRect(box.left, box.top, box.width, box.height);
    const visible = rect.bottom > view.top && rect.top < view.bottom && rect.right > view.left && rect.left < view.right;
    return { rect, visible, side: visible ? 'in' : rect.bottom <= view.top ? 'above' : 'below', view };
}
/** Top-window viewport rect of a floor frame, or null when it has no layout. Read it at flight start and landing only. */
export function floorTarget(slot) {
    const root = slot.shadowRoot;
    if (!slot.isConnected || !root)
        return null;
    // (.scene > summary is the frame folded shut)
    const part = ['.canvas', '.scene > summary', 'figure']
        .map(selector => root.querySelector(selector))
        .find(element => element && !element.hidden && element.getClientRects().length > 0);
    if (!part)
        return null;
    let { left, top, right, bottom } = part.getBoundingClientRect();
    for (let view = part.ownerDocument.defaultView; view && view !== window;) {
        let frame = null;
        try {
            frame = view.frameElement;
        }
        catch {
            return null;
        }
        if (!frame?.isConnected)
            return null;
        const box = frame.getBoundingClientRect();
        const scale = frame.offsetWidth ? box.width / frame.offsetWidth : 1;
        const style = frame.ownerDocument.defaultView.getComputedStyle(frame);
        const x = box.left + (frame.clientLeft + (parseFloat(style.paddingLeft) || 0)) * scale;
        const y = box.top + (frame.clientTop + (parseFloat(style.paddingTop) || 0)) * scale;
        [left, top, right, bottom] = [x + left * scale, y + top * scale, x + right * scale, y + bottom * scale];
        view = frame.ownerDocument.defaultView;
    }
    const chat = document.getElementById('chat')?.getBoundingClientRect();
    const clip = { top: Math.max(chat?.top ?? 0, 0), bottom: Math.min(chat?.bottom ?? innerHeight, innerHeight) };
    const visible = bottom > clip.top && top < clip.bottom && right > 0 && left < innerWidth;
    return { rect: new DOMRect(left, top, right - left, bottom - top), visible,
        side: visible ? 'in' : bottom <= clip.top ? 'above' : 'below' };
}
