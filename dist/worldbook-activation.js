// Match SillyTavern's delimited keyword regex syntax and literal fallback.
function keywordRegex(key) {
    const match = /^\/([\s\S]+?)\/([gimsuy]*)$/.exec(key);
    if (!match || /(^|[^\\])\//.test(match[1]))
        return null;
    try {
        return new RegExp(match[1].replace('\\/', '/'), match[2]);
    }
    catch {
        return null;
    }
}
function matchesKeyword(text, key, activation) {
    key = key.trim();
    if (!key)
        return false;
    const regex = keywordRegex(key);
    if (regex)
        return regex.test(text);
    const source = activation.caseSensitive ? text : text.toLowerCase();
    const needle = activation.caseSensitive ? key : key.toLowerCase();
    if (!activation.matchWholeWords || needle.split(/\s+/).length > 1)
        return source.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\W)(${escaped})(?:$|\\W)`).test(source);
}
/** Evaluate only this send's body; never scan preset text, other entries or previous messages. */
export function isWorldbookEntryActive(entry, text) {
    if (!entry.enabled)
        return false;
    const activation = entry.activation;
    if (!activation)
        throw new Error(`世界书条目“${entry.name}”缺少激活设置，请重新导入原世界书并重新选择条目。`);
    if (activation.constant)
        return true;
    const matches = (key) => matchesKeyword(text, key, activation);
    if (!activation.keys.some(matches))
        return false;
    if (!activation.selective || !activation.secondaryKeys.length)
        return true;
    switch (activation.selectiveLogic) {
        case 0: return activation.secondaryKeys.some(matches); // AND ANY
        case 1: return !activation.secondaryKeys.every(matches); // NOT ALL
        case 2: return !activation.secondaryKeys.some(matches); // NOT ANY
        case 3: return activation.secondaryKeys.every(matches); // AND ALL
    }
}
