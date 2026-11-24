const MAX_EXPANDED_CONTENT = 1_048_576;
const MAX_EXTRA_CONTENT = 16 * 1024 * 1024;
function invalid(name, detail) {
    throw new Error(`预设“${name}”里的变量宏写岔了：${detail}`);
}
function parseMacro(body, entryName) {
    const command = /^\s*(setvar|getvar)\b/i.exec(body);
    if (!command)
        return undefined;
    const kind = command[1].toLowerCase();
    const rest = body.slice(command[0].length);
    if (!/^\s*::/.test(rest))
        invalid(entryName, `要写成 {{${kind}::变量名${kind === 'setvar' ? '::值' : ''}}} 这样。`);
    const args = rest.replace(/^\s*::/, '');
    const separator = args.indexOf('::');
    if (kind === 'setvar' && separator < 0)
        invalid(entryName, 'setvar 少写了中间隔开变量值和名字的 ::。');
    const name = (kind === 'setvar' ? args.slice(0, separator) : args).trim();
    if (!name || /[{}\r\n]/.test(name) || name.includes('::'))
        invalid(entryName, '变量名不能为空，里面也不能塞换行、花括号或者 ::。');
    return kind === 'setvar'
        ? { kind, name, value: args.slice(separator + 2) }
        : { kind: 'getvar', name };
}
/** Parse only top-level macros; nested text is literal, never another execution pass. */
function parts(content, entryName) {
    const output = [];
    let cursor = 0;
    while (cursor < content.length) {
        const start = content.indexOf('{{', cursor);
        if (start < 0) {
            output.push(content.slice(cursor));
            break;
        }
        if (start > cursor)
            output.push(content.slice(cursor, start));
        const brackets = ['macro'];
        let end = start + 2;
        let quoted = false;
        while (brackets.length && end < content.length) {
            const char = content[end];
            if (quoted) {
                if (char === '\\') {
                    end += 2;
                    continue;
                }
                if (char === '"')
                    quoted = false;
                end++;
                continue;
            }
            if (char === '"') {
                quoted = true;
                end++;
                continue;
            }
            if (content.startsWith('{{', end)) {
                brackets.push('macro');
                end += 2;
                continue;
            }
            if (char === '{') {
                brackets.push('literal');
                end++;
                continue;
            }
            if (char === '}' && brackets.at(-1) === 'literal') {
                brackets.pop();
                end++;
                continue;
            }
            if (content.startsWith('}}', end)) {
                brackets.pop();
                end += 2;
                continue;
            }
            end++;
        }
        if (brackets.length) {
            if (/^\s*(setvar|getvar)\b/i.test(content.slice(start + 2)))
                invalid(entryName, '花括号或者引号没收尾，看看变量值和末尾的 }} 写全没。');
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
export function expandPresetMacros(entries) {
    const parsed = entries.map(entry => ({ entry, parts: parts(entry.content, entry.name) }));
    const variables = new Map();
    for (const item of parsed) {
        for (const part of item.parts)
            if (typeof part !== 'string' && part.kind === 'setvar')
                variables.set(part.name, part.value);
    }
    const output = new Map();
    let extraContent = 0;
    for (const item of parsed) {
        const chunks = [];
        let length = 0;
        for (const part of item.parts) {
            let value;
            if (typeof part === 'string')
                value = part;
            else if (part.kind === 'setvar')
                continue;
            else {
                if (!variables.has(part.name))
                    invalid(item.entry.name, `getvar 要取的“${part.name}”在当前开启的条目里找不着定义。`);
                value = variables.get(part.name);
            }
            length += value.length;
            if (length > MAX_EXPANDED_CONTENT)
                invalid(item.entry.name, '宏展开后正文太长了，少套几层重复引用吧。');
            chunks.push(value);
        }
        extraContent += Math.max(0, length - item.entry.content.length);
        if (extraContent > MAX_EXTRA_CONTENT)
            invalid(item.entry.name, '这次替换展开超过了 16 MiB，少写几处重复引用吧。');
        output.set(item.entry.id, chunks.join(''));
    }
    return output;
}
/** Import keeps the original preset, including inactive entries and unsupported host macros. */
export function presetMacroWarnings(content, entryName) {
    let parsed;
    try {
        parsed = parts(content, entryName);
    }
    catch (error) {
        return [`${error instanceof Error ? error.message : '变量宏没写对。'} 先把原文留着，准备开着它发请求前记得改好。`];
    }
    return parsed.some(part => typeof part === 'string' && /\{\{[\s\S]*?\}\}/.test(part))
        ? [`“${entryName}”里夹了 setvar / getvar 之外的宏，那些宏会当成普通文字留着，不会跑。`]
        : [];
}
