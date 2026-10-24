import { loadAnchors } from './anchor-store.js';
import { resolveAnchorPrompt } from './anchor-resolver.js';
import { loadSharedOutfits } from './shared-outfit-store.js';
/** Delimiters belong to the source protocol, never to tags expanded from storage. */
function separators(source) {
    const found = [];
    const brackets = [];
    const pairs = { '{': '}', '[': ']', '(': ')', '<': '>' };
    let weighted = false;
    let invalid = false;
    let hasOperator = false;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '\\') {
            index++;
            continue;
        }
        if (source.slice(index, index + 2) === '::') {
            // A closing :: belongs to the current numeric emphasis group. Plain
            // colons in copyright names and other tags never start such a group.
            if (weighted) {
                weighted = false;
                index++;
                continue;
            }
            if (/(?:^|[\s,，|~([{])[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source.slice(0, index))) {
                weighted = true;
                index++;
                continue;
            }
        }
        if (character === '|' || character === '~') {
            hasOperator = true;
            if (!weighted && !brackets.length)
                found.push({ index, value: character });
        }
        if (weighted)
            continue;
        if (pairs[character])
            brackets.push(pairs[character]);
        else if (')]}>'.includes(character) && brackets.pop() !== character)
            invalid = true;
    }
    // Leave ordinary old single-string prompts alone. With protocol symbols,
    // unmatched weights could hide an intended character boundary, so reject it.
    if (hasOperator && (invalid || weighted || brackets.length)) {
        throw new Error('角色分栏的括号或数字权重未闭合，请将 | 和 ~ 放在完整权重组之外。');
    }
    return found;
}
function parseScene(source) {
    const operators = separators(source);
    const bars = operators.filter(item => item.value === '|');
    const tildes = operators.filter(item => item.value === '~');
    if (!bars.length) {
        if (tildes.length)
            throw new Error('~ 仅用于角色分栏的专属负面词，请先用 | 分隔全局与角色提示词。');
        return { positive: source, characters: [] };
    }
    if (bars.length > 22)
        throw new Error('一张图片最多支持 22 个角色分栏，请减少角色数量。');
    const positive = source.slice(0, bars[0].index).trim();
    if (!positive)
        throw new Error('角色分栏的第一栏不能为空，请填写人数、场景或整体构图。');
    if (tildes.some(item => item.index < bars[0].index)) {
        throw new Error('全局栏不能使用 ~，全局负面词请填写在画师工坊的负面提示词中。');
    }
    const characters = bars.map((bar, index) => {
        const end = bars[index + 1]?.index ?? source.length;
        const negatives = tildes.filter(item => item.index > bar.index && item.index < end);
        if (negatives.length > 1)
            throw new Error(`第 ${index + 1} 个角色栏只能使用一个 ~ 分隔正面与负面词。`);
        const positive = source.slice(bar.index + 1, negatives[0]?.index ?? end).trim();
        const negative = negatives.length ? source.slice(negatives[0].index + 1, end).trim() : '';
        if (!positive)
            throw new Error(`第 ${index + 1} 个角色栏的正面提示词不能为空，请删除多余的 | 或补全角色。`);
        return { positive, negative };
    });
    return { positive, characters };
}
/** Parse once, then expand each positive field independently from one library snapshot. */
export async function prepareImagePrompt(scene, globalNegative, artistPositive = '') {
    const parsed = parseScene(scene);
    const positives = [parsed.positive, ...parsed.characters.map(character => character.positive)];
    const anchors = positives.some(prompt => /[\p{Script=Han}@]/u.test(prompt)) ? await loadAnchors() : [];
    const outfits = positives.some(prompt => prompt.includes('#')) ? loadSharedOutfits() : [];
    const expand = (positive) => resolveAnchorPrompt(positive, anchors, outfits);
    const positive = expand(parsed.positive);
    return {
        // Artist tags are not protocol input and are added to the global field only.
        positive: [positive, artistPositive].filter(text => text.trim()).join(', '),
        negative: globalNegative,
        characters: parsed.characters.map(character => ({ positive: expand(character.positive), negative: character.negative })),
    };
}
