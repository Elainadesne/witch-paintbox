/** Same-origin documents only; an inaccessible iframe is not a loading document. */
export function frameDocument(frame: HTMLIFrameElement): Document | null {
  try { return frame.contentDocument; } catch { return null; }
}

export function frontendFrames(root: ParentNode): HTMLIFrameElement[] {
  const frames: HTMLIFrameElement[] = [];
  const seen = new Set<Document>();
  const visit = (parent: ParentNode) => {
    for (const frame of Array.from(parent.querySelectorAll<HTMLIFrameElement>('iframe'))) {
      frames.push(frame);
      const doc = frameDocument(frame);
      if (doc && !seen.has(doc)) { seen.add(doc); visit(doc); }
    }
  };
  visit(root);
  return frames;
}

export function visibleFrontendFrame(frame: HTMLIFrameElement): boolean {
  let current: Element | null = frame;
  try {
    while (current) {
      if (!current.isConnected || current.matches('[hidden], [aria-hidden="true"]')) return false;
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
      current = current.parentElement ?? current.ownerDocument.defaultView?.frameElement ?? null;
    }
    return true;
  } catch { return false; }
}
