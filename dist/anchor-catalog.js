function nameToken(name, key = false) {
    const ambiguous = /[|=;#"\\[\]\r\n]/.test(name) || name.startsWith('@')
        || (key && /^(base|default)$/i.test(name));
    return ambiguous ? JSON.stringify(name) : name;
}
function field(name, tags) {
    // Keep user-authored weights and line endings; continuation lines cannot form new sections.
    return `${name} = ${tags.replace(/\r\n|\r|\n/g, '$&  ')}`;
}
/** User-authored anchor data only; this catalog adds no instructions to the model. */
export function formatAnchorCatalog(anchors, sharedOutfits) {
    const sections = anchors.map(anchor => {
        const selected = anchor.outfits.find(outfit => outfit.id === anchor.selectedOutfitId);
        return [
            `[${[anchor.name, ...anchor.aliases].map(name => nameToken(name)).join(' | ')}]`,
            field('base', anchor.appearance),
            field('default', selected?.tags ?? ''),
            ...anchor.outfits.map(outfit => field(nameToken(outfit.name, true), outfit.tags)),
        ].join('\n');
    });
    if (sharedOutfits.length) {
        sections.push(['[@通用服装库]', ...sharedOutfits.map(outfit => field(nameToken(outfit.name, true), outfit.tags))].join('\n'));
    }
    return sections.join('\n\n');
}
