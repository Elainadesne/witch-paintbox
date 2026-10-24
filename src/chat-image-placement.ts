import { formatChatText } from './chat-host.js';
import type { MarkerEntry } from './image-marker-history.js';
import { textLines } from './image-text-regions.js';

const PROTECTED = 'iframe, pre, code, script, style, a, button, input, textarea, select, option, '
  + 'audio, video, object, embed, canvas, svg, .witch-paintbox-image, .witch-paintbox-pending, [hidden], [aria-hidden="true"], [contenteditable="true"]';
const compact = (text: string) => text.replace(/\s/g, '');

/** Whitespace/BRs can change during Markdown rendering; all other characters must match. */
function displayedText(element: HTMLElement) {
  const parts: string[] = [];
  const nodes: Array<Text | null> = [];
  const offsets: number[] = [];
  function visit(node: Node): void {
    if (node instanceof Element && (node.matches(PROTECTED) || node.shadowRoot
      || node.tagName === 'IMG' || node instanceof HTMLElement
      && (node.style.display === 'none' || node.style.visibility === 'hidden'))) {
      // A match must never bridge an iframe, a control or another rendered image.
      parts.push('\0');
      nodes.push(null);
      offsets.push(0);
      return;
    }
    if (node instanceof Text) {
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

function markerVariants(entry: MarkerEntry, messageId: number): string[] {
  const raw = entry.marker.raw;
  // HTML treats <img> as a void element and may remove both delimiters, whereas
  // escaped displays retain them. Never locate a marker by its title alone.
  const withoutOpening = raw.replace(/^<img>/, '');
  const inner = withoutOpening.replace(/<\/img>$/, '');
  const variants = [raw, withoutOpening, raw.replace(/<\/img>$/, ''), inner];
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

/** Include the empty HTML img left by the opening marker, but never a real image. */
function includeEmptyImage(range: Range, root: HTMLElement): void {
  const first = range.startContainer;
  if (!(first instanceof Text) || first.data.slice(0, range.startOffset).trim()) return;
  let node: Node | null = first;
  while (node && node !== root) {
    if (!node.previousSibling) { node = node.parentNode; continue; }
    node = node.previousSibling;
    if ((node instanceof Text && !node.data.trim()) || node instanceof HTMLBRElement) continue;
    if (node instanceof HTMLImageElement && node.attributes.length === 0) range.setStartBefore(node);
    break;
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
      if (!first || !last) return;
      const range = document.createRange();
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

/** Map known source line boundaries to live DOM without rewriting any existing node. */
export function locateImageInsertionPoints(element: HTMLElement, messageId: number, original: string, offsets: number[]) {
  const index = displayedText(element);
  const lines = textLines(original).filter(line => original.slice(line.start, line.contentEnd).trim());
  const source = compact(original);
  function findLine(line: typeof lines[number] | undefined): { start: number; end: number } | null {
    if (!line) return null;
    const raw = original.slice(line.start, line.contentEnd).trim();
    const literal = compact(raw);
    // Do not guess which repeated line an offset refers to after other renderers hide content.
    if (!literal || source.indexOf(literal) !== source.lastIndexOf(literal)) return null;
    const variants = new Set([literal]);
    try {
      const formatted = document.createElement('div');
      formatted.innerHTML = formatChatText(raw, messageId);
      const text = compact(formatted.textContent ?? '');
      const plain = (value: string) => value.replace(/[*_`\\]/g, '');
      if (text && plain(text) === plain(literal)) variants.add(text);
    } catch { /* Use the literal complete line only. */ }
    const matches = new Map<string, { start: number; end: number }>();
    for (const needle of variants) {
      const start = index.text.indexOf(needle);
      if (start < 0) continue;
      if (start !== index.text.lastIndexOf(needle)) return null;
      matches.set(`${start}:${start + needle.length}`, { start, end: start + needle.length });
    }
    return matches.size === 1 ? [...matches.values()][0] : null;
  }
  const placements: Array<{ offset: number; range: Range; position: number }> = [];
  for (const offset of new Set(offsets)) {
    const before = findLine([...lines].reverse().find(line => line.end <= offset));
    const after = findLine(lines.find(line => line.start >= offset));
    if (before && after && before.end > after.start) continue;
    const match = before ?? after;
    if (!match) continue;
    const first = index.nodes[match.start];
    const last = index.nodes[match.end - 1];
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first, index.offsets[match.start]);
    range.setEnd(last, index.offsets[match.end - 1] + 1);
    if (!range.getClientRects().length) continue;
    range.collapse(!before);
    placements.push({ offset, range, position: before ? match.end : match.start });
  }
  return placements.sort((a, b) => b.position - a.position || b.offset - a.offset);
}
