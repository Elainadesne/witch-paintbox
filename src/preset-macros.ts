import type { PromptEntry } from './model-settings.js';

type Macro = { kind: 'setvar'; name: string; value: string } | { kind: 'getvar'; name: string };
type Part = string | Macro;
type MacroEntry = Pick<PromptEntry, 'id' | 'name' | 'content'>;
const MAX_EXPANDED_CONTENT = 1_048_576;
const MAX_EXTRA_CONTENT = 16 * 1024 * 1024;

function invalid(name: string, detail: string): never {
  throw new Error(`预设条目“${name}”的变量宏无效：${detail}`);
}

function parseMacro(body: string, entryName: string): Macro | undefined {
  const command = /^\s*(setvar|getvar)\b/i.exec(body);
  if (!command) return undefined;
  const kind = command[1].toLowerCase();
  const rest = body.slice(command[0].length);
  if (!/^\s*::/.test(rest)) invalid(entryName, `请使用 {{${kind}::变量名${kind === 'setvar' ? '::值' : ''}}}。`);
  const args = rest.replace(/^\s*::/, '');
  const separator = args.indexOf('::');
  if (kind === 'setvar' && separator < 0) invalid(entryName, 'setvar 缺少值分隔符 ::。');
  const name = (kind === 'setvar' ? args.slice(0, separator) : args).trim();
  if (!name || /[{}\r\n]/.test(name) || name.includes('::')) invalid(entryName, '变量名不能为空，也不能包含换行、花括号或 ::。');
  return kind === 'setvar'
    ? { kind, name, value: args.slice(separator + 2) }
    : { kind: 'getvar', name };
}

/** Parse only top-level macros; nested text is literal, never another execution pass. */
function parts(content: string, entryName: string): Part[] {
  const output: Part[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('{{', cursor);
    if (start < 0) { output.push(content.slice(cursor)); break; }
    if (start > cursor) output.push(content.slice(cursor, start));
    const brackets: ('macro' | 'literal')[] = ['macro'];
    let end = start + 2;
    let quoted = false;
    while (brackets.length && end < content.length) {
      const char = content[end];
      if (quoted) {
        if (char === '\\') { end += 2; continue; }
        if (char === '"') quoted = false;
        end++; continue;
      }
      if (char === '"') { quoted = true; end++; continue; }
      if (content.startsWith('{{', end)) { brackets.push('macro'); end += 2; continue; }
      if (char === '{') { brackets.push('literal'); end++; continue; }
      if (char === '}' && brackets.at(-1) === 'literal') { brackets.pop(); end++; continue; }
      if (content.startsWith('}}', end)) { brackets.pop(); end += 2; continue; }
      end++;
    }
    if (brackets.length) {
      if (/^\s*(setvar|getvar)\b/i.test(content.slice(start + 2))) invalid(entryName, '花括号或双引号未闭合，请检查变量值与末尾的 }}。');
      output.push(content.slice(start));
      return output;
    }
    const macro = parseMacro(content.slice(start + 2, end - 2), entryName);
    output.push(macro ?? content.slice(start, end));
    cursor = end;
  }
  return output;
}

/** The caller supplies only enabled, selected prompt entries, in their actual send order. */
export function expandPresetMacros(entries: readonly MacroEntry[]): Map<string, string> {
  const parsed = entries.map(entry => ({ entry, parts: parts(entry.content, entry.name) }));
  const variables = new Map<string, string>();
  for (const item of parsed) {
    for (const part of item.parts) if (typeof part !== 'string' && part.kind === 'setvar') variables.set(part.name, part.value);
  }
  const output = new Map<string, string>();
  let extraContent = 0;
  for (const item of parsed) {
    const chunks: string[] = [];
    let length = 0;
    for (const part of item.parts) {
      let value: string;
      if (typeof part === 'string') value = part;
      else if (part.kind === 'setvar') continue;
      else {
        if (!variables.has(part.name)) invalid(item.entry.name, `getvar 引用的“${part.name}”没有在本轮启用条目中定义。`);
        value = variables.get(part.name)!;
      }
      length += value.length;
      if (length > MAX_EXPANDED_CONTENT) invalid(item.entry.name, '展开后的正文过长，请减少重复引用。');
      chunks.push(value);
    }
    extraContent += Math.max(0, length - item.entry.content.length);
    if (extraContent > MAX_EXTRA_CONTENT) invalid(item.entry.name, '本次变量替换额外展开超过 16 MiB，请减少重复引用。');
    output.set(item.entry.id, chunks.join(''));
  }
  return output;
}

/** Import keeps the original preset, including inactive entries and unsupported host macros. */
export function presetMacroWarnings(content: string, entryName: string): string[] {
  let parsed: Part[];
  try { parsed = parts(content, entryName); }
  catch (error) { return [`${error instanceof Error ? error.message : '变量宏格式无效。'} 已保留原文，启用发送前请修正。`]; }
  return parsed.some(part => typeof part === 'string' && /\{\{[\s\S]*?\}\}/.test(part))
    ? [`“${entryName}”含有 setvar/getvar 以外的宏，其他宏保留原文，不执行。`]
    : [];
}
