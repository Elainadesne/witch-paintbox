import { loadAnchors } from './anchor-store.js';
import { loadSharedOutfits } from './shared-outfit-store.js';
const alternateClothing = new Set(['nude', 'completely nude', 'topless', 'bikini', 'swimsuit', 'nightgown', 'towel']);
export async function resolveStoredAnchorPrompt(prompt) {
    if (!/[\p{Script=Han}@#]/u.test(prompt))
        return prompt;
    const anchors = /[\p{Script=Han}@]/u.test(prompt) ? await loadAnchors() : [];
    const outfits = prompt.includes('#') ? loadSharedOutfits() : [];
    return resolveAnchorPrompt(prompt, anchors, outfits);
}
// Only reference names decode protocol escapes; stored tag strings and all
// other NAI escapes must survive expansion unchanged.
function referenceName(value) {
    return value.replace(/\\([|~])/g, '$1');
}
/** Unwrap whole emphasis groups only; copyright parentheses and LoRA tags stay intact. */
function wrapper(token) {
    const numeric = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))::([\s\S]*)::$/.exec(token);
    if (numeric)
        return { prefix: `${numeric[1]}::`, body: numeric[2], suffix: '::', active: Number(numeric[1]) > 0 };
    const pairs = { '{': '}', '[': ']', '(': ')', '<': '>' };
    const close = pairs[token[0]];
    if (!close || token[0] === '<' || !token.endsWith(close))
        return null;
    const stack = [];
    let weighted = false;
    for (let i = 0; i < token.length; i++) {
        const character = token[i];
        if (character === '\\') {
            i++;
            continue;
        }
        if (token.slice(i, i + 2) === '::') {
            weighted = !weighted;
            i++;
            continue;
        }
        if (weighted)
            continue;
        if (pairs[character])
            stack.push(pairs[character]);
        else if (')]}>'.includes(character)) {
            if (stack.pop() !== character || (!stack.length && i !== token.length - 1))
                return null;
        }
    }
    if (stack.length || weighted)
        return null;
    const body = token.slice(1, -1);
    const weight = token[0] === '(' ? /:([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(body) : null;
    return { prefix: token[0], body: weight ? body.slice(0, weight.index) : body,
        suffix: (weight?.[0] ?? '') + close, active: !weight || Number(weight[1]) > 0 };
}
/** Visit independent tags, preserving separators, whitespace, and original weight syntax. */
function mapTags(source, visit, depth = 0, active = true) {
    if (depth > 64)
        throw new Error('生图 tag 的权重嵌套过深，请简化后重试。');
    function part(value) {
        const token = value.trim();
        if (!token)
            return value;
        const group = wrapper(token);
        const mapped = group
            ? group.prefix + mapTags(group.body, visit, depth + 1, active && group.active) + group.suffix
            : visit(token, depth > 0, active);
        return value.slice(0, value.length - value.trimStart().length) + mapped + value.slice(value.trimEnd().length);
    }
    const closing = [];
    let weighted = false, start = 0, result = '';
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '\\') {
            index++;
            continue;
        }
        if (source.slice(index, index + 2) === '::') {
            weighted = !weighted;
            index++;
            continue;
        }
        if (weighted)
            continue;
        const bracket = '([{<'.indexOf(character);
        if (bracket >= 0)
            closing.push(')]}>'[bracket]);
        else if (character === closing.at(-1))
            closing.pop();
        else if (!closing.length && /[,，\r\n]/.test(character)) {
            result += part(source.slice(start, index)) + character;
            start = index + 1;
        }
    }
    return result + part(source.slice(start));
}
/** Expand saved content once. Explicit @/# calls never silently fall through to NAI. */
export function resolveAnchorPrompt(prompt, anchors, sharedOutfits = []) {
    const names = new Map();
    for (const anchor of anchors)
        for (const name of [anchor.name, ...anchor.aliases])
            names.set(name, anchor);
    const orderedNames = [...names.keys()].sort((a, b) => b.length - a.length);
    const shared = new Map(sharedOutfits.map(outfit => [outfit.name, outfit]));
    let omitDefault = false;
    mapTags(prompt, (token, _nested, active) => {
        if (active && (alternateClothing.has(token.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' '))
            || (token.startsWith('#') && shared.has(referenceName(token.slice(1).trim())))))
            omitDefault = true;
        return token;
    });
    function reference(token, prefixed) {
        const body = referenceName(prefixed ? token.slice(1).trim() : token);
        // Longest known name wins, including old names that contain a single colon.
        const name = orderedNames.find(name => {
            if (body === name)
                return true;
            if (!body.startsWith(name))
                return false;
            const suffix = body.slice(name.length).trimStart();
            return suffix.startsWith('/') || (prefixed && suffix.startsWith(':'));
        });
        if (!name)
            return null;
        return { anchor: names.get(name), outfit: body === name ? null : body.slice(name.length).trimStart().slice(1).trim() };
    }
    return mapTags(prompt, (token, nested) => {
        if (token.startsWith('#')) {
            const outfit = shared.get(referenceName(token.slice(1).trim()));
            if (outfit)
                return outfit.tags;
            // A pre-existing literal name beginning with # keeps its legacy meaning.
            if (nested || !reference(token, false))
                throw new Error(`通用服装“${token.slice(1).trim() || '（空）'}”不存在，请检查标签。`);
        }
        const prefixed = token.startsWith('@');
        const match = prefixed ? reference(token, true) ?? (!nested ? reference(token, false) : null)
            : !nested ? reference(token, false) : null;
        if (!match) {
            if (prefixed)
                throw new Error(`角色调用“${token}”未匹配到已保存的角色或别名，请检查标签。`);
            return token;
        }
        const { anchor, outfit: outfitName } = match;
        let outfit;
        if (outfitName !== null) {
            if (outfitName !== '无服装') {
                outfit = anchor.outfits.find(item => item.name === outfitName);
                if (!outfit && prefixed && outfitName === 'default')
                    outfit = anchor.outfits.find(item => item.id === anchor.selectedOutfitId);
                else if (!outfit && !(prefixed && outfitName === 'base')) {
                    throw new Error(`角色“${anchor.name}”没有名为“${outfitName || '（空）'}”的服装，请检查标签。`);
                }
            }
        }
        else if (!prefixed || !omitDefault) {
            outfit = anchor.outfits.find(item => item.id === anchor.selectedOutfitId);
            if (anchor.selectedOutfitId && !outfit)
                throw new Error(`角色“${anchor.name}”选中的服装不存在，请重新选择。`);
        }
        return [anchor.appearance, outfit?.tags].filter(Boolean).join(', ');
    });
}
