/** Same-origin documents only; an inaccessible iframe is not a loading document. */
export function frameDocument(frame) {
    try {
        return frame.contentDocument;
    }
    catch {
        return null;
    }
}
export function frontendFrames(root) {
    const frames = [];
    const seen = new Set();
    const visit = (parent) => {
        for (const frame of Array.from(parent.querySelectorAll('iframe'))) {
            frames.push(frame);
            const doc = frameDocument(frame);
            if (doc && !seen.has(doc)) {
                seen.add(doc);
                visit(doc);
            }
        }
    };
    visit(root);
    return frames;
}
export function visibleFrontendFrame(frame) {
    let current = frame;
    try {
        while (current) {
            if (!current.isConnected || current.matches('[hidden], [aria-hidden="true"]'))
                return false;
            const style = current.ownerDocument.defaultView?.getComputedStyle(current);
            if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse')
                return false;
            current = current.parentElement ?? current.ownerDocument.defaultView?.frameElement ?? null;
        }
        return true;
    }
    catch {
        return false;
    }
}
