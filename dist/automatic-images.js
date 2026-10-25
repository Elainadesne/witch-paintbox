import { imageChatContext, isChatReadyForImages } from './chat-host.js';
import { currentPreferences } from './settings.js';
/** Observe new source markers, never synthetic button clicks or historical DOM remounts. */
export function automaticImages(handlers) {
    const seen = new Set();
    const waiting = new Map();
    let identity = '';
    let mode = '';
    let active = null;
    let timer;
    let disposed = false;
    function cancel() {
        clearTimeout(timer);
        timer = undefined;
        waiting.clear();
        active?.controller.abort();
    }
    function arm(delay = 1000) {
        if (disposed || active || timer !== undefined || !waiting.size)
            return;
        timer = setTimeout(() => { timer = undefined; void next(); }, delay);
    }
    async function next() {
        if (disposed || active)
            return;
        const pending = [...waiting.values()].sort((a, b) => a.message.messageId - b.message.messageId || a.entry.marker.start - b.entry.marker.start)[0];
        if (!pending)
            return;
        if (pending.readyAt > Date.now()) {
            arm(pending.readyAt - Date.now());
            return;
        }
        if (!handlers.mounted(pending))
            return; // A later mount calls update() again.
        const controller = new AbortController();
        const job = { candidate: pending, controller };
        active = job;
        try {
            if (!await isChatReadyForImages())
                return;
            if (controller.signal.aborted || waiting.get(pending.entry.key) !== pending || pending.readyAt > Date.now())
                return;
            waiting.delete(pending.entry.key);
            await handlers.generate(pending, controller.signal);
        }
        catch {
            // Inline controls display failures. Never retry a paid generation automatically.
            waiting.delete(pending.entry.key);
        }
        finally {
            if (active === job)
                active = null;
            arm();
        }
    }
    return {
        settled() { waiting.forEach(item => { item.readyAt = Date.now() + 1000; }); },
        update(candidates, parsingEnabled) {
            if (disposed)
                return;
            const context = imageChatContext();
            const settings = currentPreferences();
            const nextIdentity = context ? JSON.stringify([context.scope, context.chatId]) : '';
            const enabled = parsingEnabled && settings.autoGenerateImages && Boolean(context);
            const nextMode = String(enabled);
            if (identity !== nextIdentity || mode !== nextMode) {
                cancel();
                seen.clear();
                candidates.forEach(item => seen.add(item.entry.key));
                identity = nextIdentity;
                mode = nextMode;
                return; // Opening a chat or enabling the option establishes a baseline, without billing.
            }
            const eligible = new Map(candidates.filter(item => item.message.messageId === context?.latestMessageId)
                .map(item => [item.entry.key, item]));
            if (active) {
                const current = candidates.find(item => item.entry.key === active.candidate.entry.key);
                if (!enabled || !current || current.message.text !== active.candidate.message.text)
                    active.controller.abort();
            }
            for (const [key, pending] of waiting) {
                const current = eligible.get(key);
                if (!enabled || !current)
                    waiting.delete(key);
                else if (current.message.text !== pending.message.text) {
                    waiting.set(key, { ...current, readyAt: Date.now() + 1000 });
                }
            }
            for (const candidate of candidates) {
                if (seen.has(candidate.entry.key))
                    continue;
                seen.add(candidate.entry.key);
                if (enabled && eligible.has(candidate.entry.key))
                    waiting.set(candidate.entry.key, { ...candidate, readyAt: Date.now() + 1000 });
            }
            arm();
        },
        dispose() { disposed = true; cancel(); seen.clear(); },
    };
}
