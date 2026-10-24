import { loadAnchors, type CharacterAnchor } from './anchor-store.js';

export async function resolveStoredAnchorPrompt(prompt: string): Promise<string> {
  // Names and aliases contain Han characters; ordinary English tags need no database access.
  if (!/\p{Script=Han}/u.test(prompt)) return prompt;
  return resolveAnchorPrompt(prompt, await loadAnchors());
}

/** Expand complete name tokens once, preserving unrelated tags and their separators. */
export function resolveAnchorPrompt(prompt: string, anchors: readonly CharacterAnchor[]): string {
  const names = new Map<string, CharacterAnchor>();
  for (const anchor of anchors) {
    for (const name of [anchor.name, ...anchor.aliases]) names.set(name, anchor);
  }
  function expand(part: string): string {
    const token = part.trim();
    const separator = token.indexOf('/');
    const name = separator < 0 ? token : token.slice(0, separator).trim();
    const anchor = names.get(name);
    if (!anchor) return part;
    const outfitName = separator < 0 ? null : token.slice(separator + 1).trim();
    const outfit = outfitName === '无服装' ? undefined
      : outfitName !== null ? anchor.outfits.find(item => item.name === outfitName)
        : anchor.outfits.find(item => item.id === anchor.selectedOutfitId);
    if (outfitName !== null && outfitName !== '无服装' && !outfit) {
      throw new Error(`角色“${anchor.name}”没有名为“${outfitName || '（空）'}”的服装，请检查标签。`);
    }
    if (outfitName === null && anchor.selectedOutfitId && !outfit) {
      throw new Error(`角色“${anchor.name}”选中的服装不存在，请重新选择。`);
    }
    const expanded = [anchor.appearance, outfit?.tags].filter(Boolean).join(', ');
    const leading = part.slice(0, part.length - part.trimStart().length);
    const trailing = part.slice(part.trimEnd().length);
    return leading + expanded + trailing;
  }

  // Delimiters inside weights or LoRA syntax are part of that original expression.
  const closing: string[] = [];
  let weighted = false;
  let start = 0;
  let result = '';
  for (let index = 0; index < prompt.length; index++) {
    const character = prompt[index];
    if (character === '\\') { index++; continue; }
    if (prompt.slice(index, index + 2) === '::') { weighted = !weighted; index++; continue; }
    if (weighted) continue;
    const bracket = '([{<'.indexOf(character);
    if (bracket >= 0) closing.push(')]}>'[bracket]);
    else if (character === closing.at(-1)) closing.pop();
    else if (!closing.length && /[,，\r\n]/.test(character)) {
      result += expand(prompt.slice(start, index)) + character;
      start = index + 1;
    }
  }
  return result + expand(prompt.slice(start));
}
