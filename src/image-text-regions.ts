export interface TextLine { start: number; contentEnd: number; end: number }
export interface TextRegion {
  start: number;
  end: number;
  kind: 'code' | 'html' | 'image';
  closed: boolean;
  nested?: boolean;
  /** Whole block of an excluded tag (think, UpdateVariable…), name in lower case. */
  excluded?: string;
}

export function textLines(text: string): TextLine[] {
  return Array.from(text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g))
    .filter(match => match[0].length > 0)
    .map(match => ({
      start: match.index, end: match.index + match[0].length,
      contentEnd: match.index + match[0].replace(/(?:\r\n|\r|\n)$/, '').length,
    }));
}

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
}

function tagEnd(text: string, start: number): number {
  let quote = '';
  for (let at = start + 1; at < text.length; at++) {
    const character = text[at];
    if (quote) { if (character === quote) quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return at + 1;
  }
  return -1;
}

/** From an excluded opening tag at `start` (ending at `openEnd`) to its matching close; -1 when it never closes. */
function excludedEnd(text: string, name: string, openEnd: number): number {
  const tokens = new RegExp(`<(/?)${name.replace(/[.]/g, '\\.')}(?=[\\s/>])[^<>]*>`, 'gi');
  tokens.lastIndex = openEnd;
  let depth = 1;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    if (token[1]) { if (--depth === 0) return token.index + token[0].length; }
    else if (!/\/\s*>$/.test(token[0])) depth++;
  }
  return -1;
}

/**
 * Conservative literal regions; this is deliberately not a Markdown/HTML renderer.
 * `excludedTags` (case-insensitive) swallow everything up to their matching close tag, so think blocks,
 * variable updates and the like are never offered for illustration. An unclosed one only covers its own tag.
 */
export function imageTextRegions(text: string, excludedTags: readonly string[] = []): TextRegion[] {
  const excluded = new Set(excludedTags.map(tag => tag.toLowerCase()));
  const lines = textLines(text);
  const regions: TextRegion[] = [];
  const fence = /^ {0,3}(?:> ?)*(`{3,}|~{3,})(.*)$/;
  let lineIndex = 0;
  let at = 0;
  const add = (kind: TextRegion['kind'], end: number, closed = true, nested = false, excludedTag?: string) => {
    regions.push({ start: at, end, kind, closed, ...(nested ? { nested: true } : {}), ...(excludedTag ? { excluded: excludedTag } : {}) });
    at = end;
  };
  while (at < text.length) {
    while (lineIndex < lines.length && lines[lineIndex].end <= at) lineIndex++;
    const line = lines[lineIndex];
    if (line?.start === at) {
      const source = text.slice(at, line.contentEnd);
      const opening = fence.exec(source);
      if (opening) {
        let closing: TextLine | undefined;
        for (let index = lineIndex + 1; index < lines.length; index++) {
          const candidate = fence.exec(text.slice(lines[index].start, lines[index].contentEnd));
          if (candidate && candidate[1][0] === opening[1][0]
            && candidate[1].length >= opening[1].length && !candidate[2].trim()) {
            closing = lines[index];
            break;
          }
        }
        add('code', closing?.end ?? text.length, !!closing);
        continue;
      }
      if (/^(?: {4}|\t)/.test(source)) {
        let end = line.end;
        for (let index = lineIndex + 1; index < lines.length; index++) {
          const content = text.slice(lines[index].start, lines[index].contentEnd);
          if (content.trim() && !/^(?: {4}|\t)/.test(content)) break;
          end = lines[index].end;
        }
        add('code', end);
        continue;
      }
    }
    if (text[at] === '`' && !escaped(text, at)) {
      const opening = /^`+/.exec(text.slice(at))![0];
      const ticks = /`+/g;
      ticks.lastIndex = at + opening.length;
      let closing: RegExpExecArray | null;
      do { closing = ticks.exec(text); } while (closing && closing[0].length !== opening.length);
      add('code', closing ? closing.index + closing[0].length : text.length, !!closing);
      continue;
    }
    if (text[at] === '<' && !escaped(text, at)) {
      if (/^<img\s*>/i.test(text.slice(at))) {
        const tokens = /<\/?img\s*>/gi;
        tokens.lastIndex = at;
        let depth = 0;
        let nested = false;
        let closing: RegExpExecArray | null = null;
        for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
          if (token[0][1] !== '/') { if (depth++) nested = true; }
          else if (--depth === 0) { closing = token; break; }
        }
        add('image', closing ? closing.index + closing[0].length : text.length, !!closing, nested);
        continue;
      }
      const terminator = text.startsWith('<!--', at) ? '-->' : text.startsWith('<![CDATA[', at) ? ']]>' : text.startsWith('<?', at) ? '?>' : '';
      if (terminator) {
        const end = text.indexOf(terminator, at + 2);
        add('html', end < 0 ? text.length : end + terminator.length, end >= 0);
        continue;
      }
      const tag = /^<\/?([a-z][a-z\d:-]*)(?=[\s/>]|$)/i.exec(text.slice(at));
      if (tag || text.startsWith('<!', at)) {
        const end = tagEnd(text, at);
        if (end < 0) { add('html', text.length, false); continue; }
        if (tag && tag[0][1] !== '/' && excluded.has(tag[1].toLowerCase()) && !/\/\s*>$/.test(text.slice(at, end))) {
          const close = excludedEnd(text, tag[1], end);
          if (close > 0) { add('html', close, true, false, tag[1].toLowerCase()); continue; }
        }
        if (tag && /^<(?:pre|code|script|style|textarea|title|a|button|select|option)\b/i.test(tag[0]) && !/\/\s*>$/.test(text.slice(at, end))) {
          const close = new RegExp(`</${tag[1]}\\s*>`, 'gi');
          close.lastIndex = end;
          const closing = close.exec(text);
          add('html', closing ? closing.index + closing[0].length : text.length, !!closing);
        } else add('html', end);
        continue;
      }
    }
    at++;
  }
  return regions;
}
