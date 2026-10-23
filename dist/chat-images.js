import { formatChatText, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { parseImageMarkers } from './image-markers.js';
import { loadImageSettings } from './image-settings.js';
import { loadModelSettings } from './model-settings.js';
import { generateImage } from './novelai.js';
/** Render-only controls: stored chat text always contains the original literal markers. */
export function bindChatImages(signal) {
    if (signal.aborted)
        return () => { };
    const rendered = new Map();
    // Keep requests and images across native DOM replacement and streamed text appends.
    const images = new Map();
    let timer;
    let stopped = false;
    function sameMessage(a, b) {
        return a.scope === b.scope && a.chatId === b.chatId && a.messageId === b.messageId
            && (a.swipeId ?? 0) === (b.swipeId ?? 0);
    }
    function markerEntries(message) {
        const markers = parseImageMarkers(message.text);
        const counts = new Map();
        markers.forEach(marker => counts.set(marker.raw, (counts.get(marker.raw) ?? 0) + 1));
        const occurrences = new Map();
        return markers.map(marker => {
            const occurrence = occurrences.get(marker.raw) ?? 0;
            occurrences.set(marker.raw, occurrence + 1);
            // If identical blocks are inserted/deleted, their old positions are ambiguous.
            return { marker, key: JSON.stringify([message.scope, message.chatId, message.messageId, message.swipeId ?? 0,
                    marker.raw, counts.get(marker.raw), occurrence]) };
        });
    }
    function isCurrent(message, key) {
        try {
            if (stopped || !loadModelSettings().parseImageMarkers)
                return false;
            const current = readAssistantMessages().find(item => sameMessage(item, message));
            return Boolean(current && markerEntries(current).some(entry => entry.key === key));
        }
        catch {
            return false;
        }
    }
    function clearImages() {
        images.forEach(control => control.dispose());
        images.clear();
    }
    function imageSlot(marker, message, key) {
        const slot = document.createElement('span');
        slot.className = 'witch-paintbox-image';
        slot.contentEditable = 'false';
        const shadow = slot.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>
      :host { display: inline-grid; max-width: 100%; margin: .5em 0; vertical-align: middle; }
      button { padding: .65em .8em; border: 0; border-bottom: 1px solid #a88bc7; border-radius: 0; background: #302837; color: #eadcff; cursor: pointer; font: inherit; text-align: left; white-space: normal; overflow-wrap: anywhere; }
      button:disabled { opacity: .6; cursor: wait; } button:focus-visible, a:focus-visible { outline: 2px solid #c7b1f0; outline-offset: 2px; }
      p { margin: .4em 0; font-size: .85em; overflow-wrap: anywhere; } p:empty { display: none; }
      img { max-width: 100%; max-height: 640px; object-fit: contain; } a { color: #c7b1f0; font-size: .85em; }
      [hidden] { display: none; }
    </style><button type="button"></button><p role="status"></p><img hidden><a hidden>保存图片</a>`;
        const button = shadow.querySelector('button');
        const status = shadow.querySelector('p');
        const image = shadow.querySelector('img');
        const download = shadow.querySelector('a');
        button.textContent = `生成图片 · ${marker.summary}`;
        image.alt = marker.summary;
        let request = null;
        let url = '';
        const controls = new AbortController();
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (request || !slot.isConnected || !isCurrent(message, key)
                || slot.closest('.mes')?.querySelector('textarea.edit_textarea'))
                return;
            const controller = new AbortController();
            request = controller;
            button.disabled = true;
            status.textContent = '正在生成图片…';
            try {
                const settings = loadImageSettings();
                // The model contributes only the scene. Artist positives and negatives belong to the plugin.
                const positive = [marker.prompt, settings.positive].filter(text => text.trim()).join(', ');
                const result = await generateImage(settings.connection, settings.parameters, positive, settings.negative, controller.signal);
                // A native re-render can temporarily detach the slot without invalidating its request.
                if (controller.signal.aborted || controls.signal.aborted || !isCurrent(message, key))
                    return;
                const nextUrl = URL.createObjectURL(result.blob);
                if (url)
                    URL.revokeObjectURL(url);
                url = nextUrl;
                image.src = download.href = url;
                image.hidden = download.hidden = false;
                download.download = `witch-paintbox-${result.seed}.png`;
                button.textContent = `再次生成 · ${marker.summary}`;
                status.textContent = `生成完成 · 种子 ${result.seed}`;
            }
            catch (error) {
                if (!controller.signal.aborted)
                    status.textContent = error instanceof Error ? error.message : '生图未完成，请稍后重试。';
            }
            finally {
                request = null;
                button.disabled = false;
            }
        }, { signal: controls.signal });
        return {
            message, slot,
            dispose() { controls.abort(); request?.abort(); if (url)
                URL.revokeObjectURL(url); },
        };
    }
    function render() {
        if (stopped)
            return;
        let messages;
        let enabled;
        try {
            messages = readAssistantMessages();
            enabled = loadModelSettings().parseImageMarkers;
        }
        catch {
            clearImages();
            rendered.forEach(state => state.slots.forEach(slot => slot.remove()));
            rendered.clear();
            return;
        }
        const byId = new Map(messages.map(message => [message.messageId, message]));
        const entriesById = new Map();
        const entriesFor = (message) => {
            let entries = entriesById.get(message.messageId);
            if (!entries) {
                try {
                    entries = markerEntries(message);
                }
                catch {
                    entries = [];
                }
                entriesById.set(message.messageId, entries);
            }
            return entries;
        };
        for (const [key, control] of images) {
            const current = byId.get(control.message.messageId);
            if (!enabled || !current || !sameMessage(current, control.message)
                || !entriesFor(current).some(entry => entry.key === key)) {
                control.dispose();
                images.delete(key);
            }
        }
        for (const [element, state] of rendered) {
            const current = byId.get(state.messageId);
            if (!element.isConnected || !current || !sameMessage(current, state) || current.text !== state.text || !enabled
                || state.slots.some(slot => !element.contains(slot))) {
                rendered.delete(element);
                if (element.isConnected && current && state.slots.some(slot => element.contains(slot))
                    && !element.closest('.mes')?.querySelector('textarea.edit_textarea')) {
                    try {
                        element.innerHTML = formatChatText(current.text, current.messageId);
                    }
                    catch { /* Keep native display if unavailable. */ }
                }
            }
        }
        if (!enabled)
            return;
        for (const block of Array.from(document.querySelectorAll('#chat > .mes[mesid]'))) {
            const element = block.querySelector('.mes_text');
            if (!element)
                continue;
            const messageId = Number(block.getAttribute('mesid'));
            const message = byId.get(messageId);
            if (!message || block.querySelector('textarea.edit_textarea'))
                continue;
            const previous = rendered.get(element);
            if (previous?.text === message.text && sameMessage(previous, message)
                && previous.slots.every(slot => slot.isConnected && element.contains(slot)))
                continue;
            if (previous)
                rendered.delete(element);
            const entries = entriesFor(message);
            if (!entries.length)
                continue;
            const state = { ...message, slots: [] };
            let prefix;
            do {
                prefix = `WITCHPAINTBOX${crypto.getRandomValues(new Uint32Array(2)).join('X')}MARK`;
            } while (message.text.includes(prefix));
            let cursor = 0;
            const parts = [];
            const tokens = entries.map(({ marker }, index) => {
                const token = `${prefix}${index}END`;
                parts.push(message.text.slice(cursor, marker.start), token);
                cursor = marker.end;
                return token;
            });
            parts.push(message.text.slice(cursor));
            const formatted = document.createElement('div');
            try {
                formatted.innerHTML = formatChatText(parts.join(''), messageId);
            }
            catch {
                continue;
            }
            let valid = true;
            const placeholders = [];
            for (let index = 0; index < tokens.length; index++) {
                const walker = document.createTreeWalker(formatted, NodeFilter.SHOW_TEXT);
                let found = null;
                let node;
                while ((node = walker.nextNode())) {
                    if (node.textContent?.includes(tokens[index])) {
                        if (found) {
                            valid = false;
                            break;
                        }
                        found = node;
                    }
                }
                if (!valid || !found || found.parentElement?.closest('code, pre, a, button, textarea, select, option, script, style')) {
                    valid = false;
                    break;
                }
                const offset = found.data.indexOf(tokens[index]);
                if (found.data.indexOf(tokens[index], offset + tokens[index].length) !== -1) {
                    valid = false;
                    break;
                }
                const trailing = found.splitText(offset);
                trailing.splitText(tokens[index].length);
                const placeholder = document.createElement('span');
                trailing.replaceWith(placeholder);
                placeholders.push(placeholder);
            }
            if (!valid)
                continue;
            // Validate every placeholder before moving any existing controls into the new display.
            entries.forEach(({ marker, key }, index) => {
                let control = images.get(key);
                if (!control) {
                    control = imageSlot(marker, message, key);
                    images.set(key, control);
                }
                placeholders[index].replaceWith(control.slot);
                state.slots.push(control.slot);
            });
            element.replaceChildren(...Array.from(formatted.childNodes));
            rendered.set(element, state);
        }
    }
    function schedule() {
        if (stopped || timer !== undefined)
            return;
        timer = setTimeout(() => { timer = undefined; render(); }, 0);
    }
    let stopWatching = () => { };
    try {
        stopWatching = watchChatRendering(schedule);
    }
    catch { /* The DOM observer can still follow native re-renders. */ }
    const observer = new MutationObserver(schedule);
    observer.observe(document.getElementById('chat') ?? document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
    window.addEventListener('storage', schedule, { signal });
    schedule();
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearTimeout(timer);
        observer.disconnect();
        stopWatching();
        let current = [];
        try {
            current = readAssistantMessages();
        }
        catch { /* Host is already unloading. */ }
        clearImages();
        for (const [element, state] of rendered) {
            if (element.isConnected && !element.closest('.mes')?.querySelector('textarea.edit_textarea')
                && current.some(message => sameMessage(message, state) && message.text === state.text)) {
                try {
                    element.innerHTML = formatChatText(state.text, state.messageId);
                }
                catch {
                    state.slots.forEach(slot => slot.remove());
                }
            }
        }
        rendered.clear();
    };
    signal.addEventListener('abort', stop, { once: true });
    return stop;
}
