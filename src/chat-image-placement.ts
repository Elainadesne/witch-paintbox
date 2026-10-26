import { formatChatText } from './chat-host.js';
import type { MarkerEntry } from './image-marker-history.js';
import { textLines } from './image-text-regions.js';
import { frameDocument, frontendFrames, visibleFrontendFrame } from './frontend-frames.js';

const PROTECTED = 'pre, code, script, style, a, button, input, textarea, select, option, '
  + 'audio, video, object, embed, canvas, svg, .witch-paintbox-image, .witch-paintbox-pending, '
  + '.rpg-log-section, .wlog-report-panel, .auto-system-panel, #story-image-slot, #variable-panel, '
  + '[hidden], [aria-hidden="true"], [contenteditable="true"]';
const compact = (text: string) => text.replace(/\s/g, '');

function isElement(node: Node | null | undefined): node is Element {
  return Boolean(node && node.nodeType === Node.ELEMENT_NODE);
}

function isHtmlElement(node: Node | null | undefined): node is HTMLElement {
  return Boolean(node && node.nodeType === Node.ELEMENT_NODE && 'style' in node);
}

function isText(node: Node | null | undefined): node is Text {
  return Boolean(node && node.nodeType === Node.TEXT_NODE);
}

function isImg(node: Node | null | undefined): node is HTMLImageElement {
  return isElement(node) && node.tagName === 'IMG';
}

function isBr(node: Node | null | undefined): node is HTMLBRElement {
  return isElement(node) && node.tagName === 'BR';
}

function isIframe(node: Node | null | undefined): node is HTMLIFrameElement {
  return isElement(node) && node.tagName === 'IFRAME';
}

/** Resolve the narrative container inside a same-origin heavy-frontend iframe when ready. */
export function iframeNarrativeRoot(frame: HTMLIFrameElement): { root: HTMLElement | null; pending: boolean } {
  if (!visibleFrontendFrame(frame) || frame.closest(PROTECTED)) return { root: null, pending: false };
  try {
    const doc = frameDocument(frame);
    const win = frame.contentWindow as (Window & { GameInitState?: string }) | null;
    if (!doc) return { root: null, pending: false };
    if (!doc.body || doc.readyState === 'loading') return { root: null, pending: true };
    const reading = doc.querySelector<HTMLElement>('#readingContent, .reading-content');
    if (reading) {
      const busy = doc.body.classList.contains('render-pending') || reading.getAttribute('aria-busy') === 'true';
      return { root: busy ? null : reading, pending: busy };
    }
    const gameText = doc.querySelector<HTMLElement>('#game-text-display, .game-text-container');
    if (gameText) {
      const busy = Boolean(win && 'GameInitState' in win && win.GameInitState !== 'READY');
      return { root: busy ? null : gameText, pending: busy };
    }
    return { root: doc.body, pending: false };
  } catch {
    return { root: null, pending: false };
  }
}

export function hasPendingFrontendFrame(element: HTMLElement): boolean {
  for (const frame of frontendFrames(element)) {
    if (iframeNarrativeRoot(frame).pending) return true;
  }
  return false;
}

export function primaryNarrativeContainer(element: HTMLElement): HTMLElement {
  for (const frame of frontendFrames(element)) {
    const { root } = iframeNarrativeRoot(frame);
    if (root && (root.id === 'readingContent' || root.id === 'game-text-display'
      || root.classList.contains('reading-content') || root.classList.contains('game-text-container'))) {
      return root;
    }
  }
  return element.querySelector<HTMLElement>('#readingContent, #game-text-display, .reading-content, .game-text-container') ?? element;
}

/** Whitespace/BRs can change during Markdown rendering; all other characters must match. */
function displayedText(element: HTMLElement) {
  const parts: string[] = [];
  const nodes: Array<Text | null> = [];
  const offsets: number[] = [];
  const boundary = () => {
    parts.push('\0');
    nodes.push(null);
    offsets.push(0);
  };
  function visit(node: Node): void {
    if (isIframe(node)) {
      boundary();
      const { root } = iframeNarrativeRoot(node);
      if (root) {
        root.childNodes.forEach(visit);
        boundary();
      }
      return;
    }
    if (isElement(node) && (node.matches(PROTECTED) || node.shadowRoot
      || isImg(node) || isHtmlElement(node)
      && (node.style.display === 'none' || node.style.visibility === 'hidden'))) {
      // A match must never bridge an unprotected iframe, a control or another rendered image.
      boundary();
      return;
    }
    if (isText(node)) {
      const text: string[] = [];
      for (let offset = 0; offset < node.data.length; offset++) {
        const char = node.data[offset];
        if (/\s/.test(char)) continue;
        text.push(char);
        nodes.push(node);
        offsets.push(offset);
      }
      parts.push(text.join(''));
    } else node.childNodes.forEach(visit);
  }
  element.childNodes.forEach(visit);
  return { text: parts.join(''), nodes, offsets };
}

function zhihuijiParagraphVariant(inner: string): string {
  return inner.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed || /^\{\{.*\}\}/.test(trimmed)) return trimmed;
    const brace = /^\{([^}]+)\}\s*(.+)$/.exec(trimmed);
    return brace ? brace[2].replace(/\{[^}]+\}/g, '').trim() : trimmed;
  }).join('\n').replace(/\*\*/g, '');
}

function markerVariants(entry: MarkerEntry, messageId: number): string[] {
  const raw = entry.marker.raw;
  // HTML treats <img> as a void element and may remove both delimiters, whereas
  // escaped displays retain them. Never locate a marker by its title alone.
  const withoutOpening = raw.replace(/^<img>/, '');
  const inner = withoutOpening.replace(/<\/img>$/, '');
  const variants = [
    raw,
    withoutOpening,
    raw.replace(/<\/img>$/, ''),
    inner,
    inner.replace(/[*_`\\]/g, ''),
    zhihuijiParagraphVariant(inner),
  ];
  try {
    const formatted = document.createElement('div');
    formatted.innerHTML = formatChatText(raw, messageId);
    const text = formatted.textContent ?? '';
    const displayed = text.trim().replace(/^<img>/, '').replace(/<\/img>$/, '');
    // Markdown may consume emphasis/escape characters. Display regex replacements
    // must still retain all title and prompt content, not just a generic caption.
    const plain = (value: string) => compact(value).replace(/[*_`\\]/g, '');
    if (plain(displayed) === plain(inner)) variants.push(text);
  } catch { /* Literal text can still be placed if formatting is unavailable. */ }
  return [...new Set(variants.map(compact).filter(text => text && !text.includes('\0')))];
}

function isEmptyMarkerImage(node: Node): boolean {
  if (isImg(node)) return node.attributes.length === 0;
  if (!isHtmlElement(node) || !node.classList.contains('image-container')) return false;
  const imgs = node.querySelectorAll('img');
  return imgs.length === 1 && imgs[0].attributes.length === 0 && !node.textContent?.trim()
    && Array.from(node.querySelectorAll('*')).every(child => child === imgs[0]
      || /^(DIV|SPAN|BR)$/.test(child.tagName) && !child.shadowRoot);
}

/** Include the empty HTML img (or empty image-container wrapper) left by the opening marker, but never a real image. */
function includeEmptyImage(range: Range, root: HTMLElement): void {
  const first = range.startContainer;
  if (!isText(first) || first.data.slice(0, range.startOffset).trim()) return;
  const last = range.endContainer;
  const startBlock = isElement(first.parentNode) && first.parentNode.tagName === 'P' ? first.parentNode : null;
  const endBlock = isText(last) && !last.data.slice(range.endOffset).trim()
    && isElement(last.parentNode) && last.parentNode.tagName === 'P' && !last.nextSibling
    ? last.parentNode : null;
  let node: Node | null = first;
  let emptyImage: Node | null = null;
  while (node && node !== root && node !== first.ownerDocument?.body) {
    if (!node.previousSibling) { node = node.parentNode; continue; }
    node = node.previousSibling;
    if ((isText(node) && !node.data.trim()) || isBr(node)) continue;
    if (isEmptyMarkerImage(node)) emptyImage = node;
    break;
  }
  if (emptyImage) {
    range.setStartBefore(emptyImage);
    if (endBlock && endBlock.parentNode === emptyImage.parentNode) range.setEndAfter(endBlock);
  } else if (startBlock && endBlock && startBlock.parentNode === endBlock.parentNode
    && (!startBlock.textContent || startBlock.firstChild === first)) {
    range.setStartBefore(startBlock);
    range.setEndAfter(endBlock);
  }
}

/** Locate ranges in the live floor. Detached formatting is used only for text comparison. */
export function locateImageMarkers(element: HTMLElement, messageId: number, entries: MarkerEntry[]) {
  const index = displayedText(element);
  const groups = new Map<string, MarkerEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.marker.raw) ?? [];
    group.push(entry);
    groups.set(entry.marker.raw, group);
  }
  const placements: Array<{ entry: MarkerEntry; start: number; end: number; range: Range }> = [];
  for (const group of groups.values()) {
    const matches: Array<{ start: number; end: number }> = [];
    for (const needle of markerVariants(group[0], messageId)) {
      for (let from = 0; from < index.text.length;) {
        const start = index.text.indexOf(needle, from);
        if (start < 0) break;
        const end = start + needle.length;
        matches.push({ start, end });
        from = end;
      }
    }
    // Prefer a match including literal delimiters over its inner-text variant.
    const unique = matches.filter((match, i) => !matches.some((other, j) => j !== i
      && other.start <= match.start && other.end >= match.end
      && (other.start < match.start || other.end > match.end || j < i)))
      .sort((a, b) => a.start - b.start);
    // A regex can hide or duplicate a marker. Do not attach another occurrence's history.
    if (unique.length !== group.length) continue;
    unique.forEach(({ start, end }, occurrence) => {
      const first = index.nodes[start];
      const last = index.nodes[end - 1];
      if (!first || !last || first.ownerDocument !== last.ownerDocument) return;
      const range = first.ownerDocument.createRange();
      range.setStart(first, index.offsets[start]);
      range.setEnd(last, index.offsets[end - 1] + 1);
      if (!range.getClientRects().length) return;
      includeEmptyImage(range, element);
      placements.push({ entry: group[occurrence], start, end, range });
    });
  }
  // Different raw markers may format to the same text. Leave ambiguous regions untouched.
  return placements.filter((placement, i) => !placements.some((other, j) => j !== i
    && placement.start < other.end && placement.end > other.start))
    .sort((a, b) => b.start - a.start);
}

function lineVariants(raw: string, messageId: number): Set<string> {
  const literal = compact(raw);
  const variants = new Set<string>();
  if (literal) variants.add(literal);
  const strippedTags = raw
    .replace(/<\/?(?:now_plot|gametxt|content)\b[^>]*>/gi, '')
    .replace(/<\/?台词(?:[：:][^<>\n]*)?>/g, '')
    .trim();
  if (strippedTags && strippedTags !== raw) {
    const clean = compact(strippedTags);
    if (clean) variants.add(clean);
    const plain = clean.replace(/[*_`\\]/g, '');
    if (plain) variants.add(plain);
  }
  const brace = /^\{([^}]+)\}\s*(.+)$/.exec( strippedTags || raw );
  if (brace) {
    const dialogueBody = compact(brace[2].replace(/\{[^}]+\}/g, '').replace(/\*\*/g, ''));
    const withSpeaker = compact(brace[1] + brace[2].replace(/\{[^}]+\}/g, '').replace(/\*\*/g, ''));
    if (dialogueBody) variants.add(dialogueBody);
    if (withSpeaker) variants.add(withSpeaker);
  }
  try {
    const formatted = document.createElement('div');
    formatted.innerHTML = formatChatText(raw, messageId);
    const text = compact(formatted.textContent ?? '');
    const plain = (value: string) => value.replace(/[*_`\\]/g, '');
    if (text && plain(text) === plain(literal)) variants.add(text);
  } catch { /* Use literal and frontend-cleaned line variants. */ }
  return variants;
}

/** Step out of inline/paragraph/dialogue wrappers so inserted frames sit at the narrative flow level. */
function snapInsertionRangeToBlock(range: Range, after: boolean): void {
  const node = range.startContainer;
  if (!isElement(node) && !isText(node)) return;
  const element = isElement(node) ? node : node.parentElement;
  let block = element?.closest('.dialogue-container, .guimi-dlg, p');
  while (block?.parentNode) {
    // A real newline can be a BR inside a larger paragraph. Do not move past
    // remaining prose or widgets just to place a div outside that paragraph.
    const rest = range.cloneRange();
    rest.selectNodeContents(block);
    if (after) rest.setStart(range.startContainer, range.startOffset);
    else rest.setEnd(range.startContainer, range.startOffset);
    const fragment = rest.cloneContents();
    if (fragment.textContent?.trim() || fragment.querySelector('img, iframe, input, button, video, audio, canvas, svg, .witch-paintbox-image')) break;
    if (after) range.setStartAfter(block);
    else range.setStartBefore(block);
    range.collapse(true);
    block = block.parentElement?.closest('.dialogue-container, .guimi-dlg, p');
  }
}

/** Map known source line boundaries to live DOM without rewriting any existing node. */
export function locateImageInsertionPoints(element: HTMLElement, messageId: number, original: string, offsets: number[]) {
  const index = displayedText(element);
  const lines = textLines(original).filter(line => original.slice(line.start, line.contentEnd).trim());
  const source = compact(original);
  const narrativeEnd = (line: typeof lines[number]): number => {
    const raw = original.slice(line.start, line.contentEnd);
    const close = /<\/(?:now_plot|gametxt|content)\s*>\s*$/i.exec(raw);
    return close ? line.start + close.index : line.end;
  };
  function findLine(line: typeof lines[number] | undefined): { start: number; end: number } | null {
    if (!line) return null;
    const raw = original.slice(line.start, line.contentEnd).trim();
    const literal = compact(raw);
    // Do not guess which repeated line an offset refers to after other renderers hide content.
    if (!literal || source.indexOf(literal) !== source.lastIndexOf(literal)) return null;
    const variants = lineVariants(raw, messageId);
    const matches = new Map<string, { start: number; end: number }>();
    for (const needle of variants) {
      if (!needle) continue;
      const start = index.text.indexOf(needle);
      if (start < 0) continue;
      if (start !== index.text.lastIndexOf(needle)) return null;
      matches.set(`${start}:${start + needle.length}`, { start, end: start + needle.length });
    }
    const all = [...matches.values()];
    // Speaker + dialogue and dialogue-only variants can describe one location.
    const unique = all.filter(match => !all.some(other => other !== match
      && other.start <= match.start && other.end >= match.end));
    return unique.length === 1 ? unique[0] : null;
  }
  const placements: Array<{ offset: number; range: Range; position: number }> = [];
  for (const offset of new Set(offsets)) {
    const before = findLine([...lines].reverse().find(line => narrativeEnd(line) <= offset));
    const after = findLine(lines.find(line => line.start >= offset));
    if (before && after && before.end > after.start) continue;
    const match = before ?? after;
    if (!match) continue;
    const first = index.nodes[match.start];
    const last = index.nodes[match.end - 1];
    if (!first || !last || first.ownerDocument !== last.ownerDocument) continue;
    const range = first.ownerDocument.createRange();
    range.setStart(first, index.offsets[match.start]);
    range.setEnd(last, index.offsets[match.end - 1] + 1);
    if (!range.getClientRects().length) continue;
    range.collapse(!before);
    snapInsertionRangeToBlock(range, Boolean(before));
    placements.push({ offset, range, position: before ? match.end : match.start });
  }
  return placements.sort((a, b) => b.position - a.position || b.offset - a.offset);
}
