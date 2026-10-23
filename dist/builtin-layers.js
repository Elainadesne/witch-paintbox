import { loadAnchors } from './anchor-store.js';
import { resolveAnchorPrompt } from './anchor-resolver.js';
import { registerFeatureLayer } from './feature-layers.js';
import { readWorldbook } from './worldbook-source.js';
import { isWorldbookEntryActive } from './worldbook-activation.js';
/** Only existing user-authored content is sent; neither provider adds instructions. */
export function registerBuiltinLayers() {
    const unregister = [
        registerFeatureLayer({
            id: 'worldbook', title: '世界书',
            async messages(context) {
                const messages = [];
                for (const selected of context.settings?.worldbooks ?? []) {
                    if (!selected.entries.length)
                        continue;
                    const entries = await readWorldbook(selected.name, context.signal);
                    context.signal?.throwIfAborted();
                    if (selected.entries.some(id => !entries.some(entry => entry.id === id))) {
                        throw new Error(`世界书“${selected.name}”中有已挂载条目被删除，请重新选择。`);
                    }
                    const content = entries.filter(entry => selected.entries.includes(entry.id) && entry.enabled && entry.content.trim())
                        .filter(entry => isWorldbookEntryActive(entry, context.sourceText ?? ''))
                        .map(entry => entry.content).join('\n\n');
                    if (content)
                        messages.push({ role: 'system', content });
                }
                return messages;
            },
        }),
        registerFeatureLayer({
            id: 'anchors', title: '标签锚定',
            async messages(context) {
                const anchors = await loadAnchors();
                context.signal?.throwIfAborted();
                const content = anchors.map(anchor => `${anchor.name}{${resolveAnchorPrompt(anchor.name, anchors)}}`).join('\n');
                return content ? [{ role: 'system', content }] : [];
            },
        }),
    ];
    return () => unregister.forEach(stop => stop());
}
