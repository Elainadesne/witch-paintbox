import { formatChatText, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { loadImageSettings } from './image-settings.js';
import { loadModelSettings } from './model-settings.js';
import { generateImage } from './novelai.js';
import { createChatImageView } from './chat-image-view.js';
import { createImageGallery } from './image-gallery.js';
import { loadImageHistory, saveImageHistory, deleteImageHistory } from './image-history.js';
import { markerEntries } from './image-marker-history.js';
import { resolveStoredAnchorPrompt } from './anchor-resolver.js';
/** Hidden or transformed markers must not suppress the other buttons in a floor. */
function prepareImageDisplay(message, entries) {
    let prefix;
    do {
        prefix = `WITCHPAINTBOX${crypto.getRandomValues(new Uint32Array(2)).join('X')}MARK`;
    } while (message.text.includes(prefix));
    let candidates = entries.map(entry => ({ ...entry, token: `${prefix}${entry.marker.start}END` }));
    while (candidates.length) {
        let cursor = 0;
        const parts = [];
        for (const { marker, token } of candidates) {
            parts.push(message.text.slice(cursor, marker.start), token);
            cursor = marker.end;
        }
        parts.push(message.text.slice(cursor));
        const formatted = document.createElement('div');
        formatted.innerHTML = formatChatText(parts.join(''), message.messageId);
        const html = formatted.innerHTML;
        const placements = candidates.flatMap(entry => {
            const walker = document.createTreeWalker(formatted, NodeFilter.SHOW_TEXT);
            let found = null;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent?.includes(entry.token))
                    continue;
                if (found || node.parentElement?.closest('code, pre, a, button, textarea, select, option, script, style'))
                    return [];
                found = node;
            }
            if (!found)
                return [];
            const offset = found.data.indexOf(entry.token);
            if (found.data.indexOf(entry.token, offset + entry.token.length) !== -1)
                return [];
            // A beautifier may also copy its content into attributes or comments.
            // Only commit a token which occurs exactly once in the complete display.
            if (html.split(entry.token).length !== 2)
                return [];
            return [{ ...entry, node: found, offset }];
        });
        if (placements.length !== candidates.length) {
            // Reformat with unsuccessful markers left as their original text. This
            // preserves native hidden/code displays and never leaves tokens on screen.
            candidates = placements;
            continue;
        }
        // Work backwards so splitting one text node does not shift later offsets.
        const slots = placements.map(placement => ({ ...placement, placeholder: document.createElement('span') }));
        const byNode = new Map();
        for (const slot of slots) {
            const group = byNode.get(slot.node) ?? [];
            group.push(slot);
            byNode.set(slot.node, group);
        }
        for (const group of byNode.values()) {
            for (const { node, offset, token, placeholder } of group.sort((a, b) => b.offset - a.offset)) {
                const trailing = node.splitText(offset);
                trailing.splitText(token.length);
                trailing.replaceWith(placeholder);
            }
        }
        return { formatted, slots };
    }
    return null;
}
/** Render-only controls: stored chat text always contains the original literal markers. */
export function bindChatImages(signal) {
    if (signal.aborted)
        return () => { };
    const rendered = new Map();
    // Keep requests and images across native DOM replacement and streamed text appends.
    const images = new Map();
    const warnings = new WeakMap();
    let timer;
    let stopped = false;
    function warnRendering(element, message, reason) {
        const previous = warnings.get(element);
        if (previous?.text === message.text && previous.reason === reason)
            return;
        warnings.set(element, { text: message.text, reason });
        // Do not print chat content, image prompts, or connection settings.
        console.warn(`[魔女画匣] 第 ${message.messageId + 1} 楼：${reason}`);
    }
    function sameMessage(a, b) {
        return a.scope === b.scope && a.chatId === b.chatId && a.messageId === b.messageId
            && (a.swipeId ?? 0) === (b.swipeId ?? 0) && a.historyId === b.historyId;
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
    function imageSlot(marker, message, key, historyKey) {
        const controls = new AbortController();
        const { slot, root, button, buttonLabel, cancel, status, canvas, preview, image, placeholder, download, refreshTheme } = createChatImageView(marker.summary, controls.signal);
        let request = null;
        let history = [];
        const saves = new Map();
        let selectedId = null;
        let phase = 'queued';
        const gallery = createImageGallery(marker.summary, controls.signal, {
            onSelect(id) { selectedId = id; showSelected(); },
            async onDelete(id) {
                const index = history.findIndex(item => item.entry.id === id);
                if (index < 0)
                    return;
                await saves.get(id)?.catch(() => { });
                // A save can time out after committing; deleting a missing record is safe.
                if (historyKey)
                    await deleteImageHistory(id);
                if (controls.signal.aborted)
                    return;
                const removed = history.find(item => item.entry.id === id);
                history = history.filter(item => item.entry.id !== id);
                if (selectedId === id)
                    selectedId = history[Math.min(index, history.length - 1)]?.entry.id ?? null;
                showSelected();
                if (removed)
                    URL.revokeObjectURL(removed.url);
                if (!request) {
                    status.dataset.error = 'false';
                    status.textContent = history.length ? `已删除图片 · 剩余 ${history.length} 张` : '图片已删除，可重新生成。';
                }
            },
        });
        root.append(gallery.element);
        function showSelected() {
            const selected = history.find(item => item.entry.id === selectedId);
            preview.hidden = download.hidden = !selected;
            placeholder.hidden = Boolean(selected);
            canvas.hidden = !selected && !request;
            if (selected) {
                image.src = download.href = selected.url;
                image.title = `种子 ${selected.entry.seed}`;
                download.download = `witch-paintbox-${selected.entry.seed}.png`;
                slot.style.setProperty('--image-ratio', String(selected.entry.parameters.width / selected.entry.parameters.height));
            }
            else {
                image.removeAttribute('src');
                download.removeAttribute('href');
            }
            if (!request)
                buttonLabel.textContent = history.length ? '再绘一张' : '生成图片';
            gallery.setImages(history, selectedId);
        }
        button.disabled = true;
        status.textContent = '正在读取图片历史…';
        const historyReady = (historyKey ? loadImageHistory(historyKey) : Promise.resolve([])).then(entries => {
            if (controls.signal.aborted)
                return;
            history = entries.map(entry => ({ entry, url: URL.createObjectURL(entry.blob) }));
            selectedId = history.at(-1)?.entry.id ?? null;
            showSelected();
            if (!request)
                status.textContent = historyKey
                    ? history.length ? `已恢复 ${history.length} 张图片 · 点击查看历史` : ''
                    : '本楼层缺少唯一时间标识，图片仅保留在当前页面，可下载保存。';
        }).catch(error => {
            if (controls.signal.aborted)
                return;
            status.dataset.error = 'true';
            status.textContent = error instanceof Error ? error.message : '图片历史读取失败。';
        }).finally(() => { button.disabled = Boolean(request); });
        preview.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (history.length)
                gallery.open();
        }, { signal: controls.signal });
        cancel.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            request?.abort();
        }, { signal: controls.signal });
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (request || !slot.isConnected || !isCurrent(message, key)
                || slot.closest('.mes')?.querySelector('textarea.edit_textarea'))
                return;
            const controller = new AbortController();
            request = controller;
            button.disabled = true;
            cancel.hidden = false;
            phase = 'queued';
            status.dataset.error = 'false';
            status.textContent = '正在加入队列…';
            try {
                const settings = loadImageSettings();
                const scene = await resolveStoredAnchorPrompt(marker.prompt);
                controller.signal.throwIfAborted();
                // The model contributes only the scene. Artist positives and negatives belong to the plugin.
                const positive = [scene, settings.positive].filter(text => text.trim()).join(', ');
                await historyReady;
                controller.signal.throwIfAborted();
                if (!isCurrent(message, key)) {
                    controller.abort();
                    controller.signal.throwIfAborted();
                }
                if (!history.length)
                    slot.style.setProperty('--image-ratio', String(settings.parameters.width / settings.parameters.height));
                canvas.hidden = false;
                canvas.dataset.busy = 'true';
                const result = await generateImage(settings.connection, settings.parameters, positive, settings.negative, controller.signal, progress => {
                    if (controls.signal.aborted || controller.signal.aborted)
                        return;
                    if (!isCurrent(message, key)) {
                        controller.abort();
                        return;
                    }
                    phase = progress.state;
                    canvas.dataset.phase = phase;
                    buttonLabel.textContent = phase === 'queued' ? '已加入队列' : '正在绘制…';
                    cancel.textContent = phase === 'queued' ? '取消排队' : '取消等待';
                    status.textContent = progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在绘制…';
                });
                // A native re-render can temporarily detach the slot without invalidating its request.
                if (controller.signal.aborted || controls.signal.aborted || !isCurrent(message, key))
                    return;
                const entry = {
                    id: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`,
                    markerKey: historyKey ?? key, blob: result.blob, createdAt: Date.now(),
                    parameters: { ...settings.parameters, seed: result.seed }, positive, negative: settings.negative, seed: result.seed,
                    scenePrompt: marker.prompt,
                };
                const saving = historyKey ? saveImageHistory(entry) : Promise.resolve();
                saves.set(entry.id, saving);
                history.push({ entry, url: URL.createObjectURL(result.blob) });
                selectedId = entry.id;
                showSelected();
                cancel.hidden = true;
                status.textContent = '绘制完成，正在保存图片历史…';
                try {
                    await saving;
                    if (!controls.signal.aborted)
                        status.textContent = historyKey
                            ? `已保存 ${history.length} 张图片 · 点击查看历史`
                            : '本楼层缺少唯一时间标识，图片仅保留在当前页面，可下载保存。';
                }
                catch (error) {
                    if (!controls.signal.aborted) {
                        status.dataset.error = 'true';
                        status.textContent = `图片已生成，但历史未保存：${error instanceof Error ? error.message : '浏览器存储不可用。'}`;
                    }
                }
                finally {
                    saves.delete(entry.id);
                }
            }
            catch (error) {
                if (controls.signal.aborted)
                    return;
                status.dataset.error = String(!controller.signal.aborted);
                status.textContent = controller.signal.aborted
                    ? phase === 'queued' ? '已取消排队。' : '已取消等待，服务端任务可能仍在继续。'
                    : error instanceof Error ? error.message : '生图未完成，请稍后重试。';
            }
            finally {
                request = null;
                button.disabled = false;
                buttonLabel.textContent = history.length ? '再绘一张' : '生成图片';
                cancel.hidden = true;
                canvas.dataset.busy = 'false';
                delete canvas.dataset.phase;
                if (!history.length)
                    canvas.hidden = true;
            }
        }, { signal: controls.signal });
        return {
            message, slot, closePreview: gallery.close, refreshTheme,
            dispose() { controls.abort(); request?.abort(); history.forEach(item => URL.revokeObjectURL(item.url)); history = []; },
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
        for (const block of Array.from(document.querySelectorAll('#chat .mes[mesid]'))) {
            if (!block.isConnected || block.parentElement?.closest('.mes'))
                continue;
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
            if (!entries.length) {
                if (/<img\s*>/i.test(message.text))
                    warnRendering(element, message, '未解析到有效图片标记；请检查标记格式或其所在的代码/HTML 区域。');
                continue;
            }
            const state = { ...message, slots: [] };
            let display;
            try {
                display = prepareImageDisplay(message, entries);
            }
            catch {
                warnRendering(element, message, `已识别 ${entries.length} 个图片标记，但酒馆格式化或按钮定位失败。`);
                continue;
            }
            if (!display) {
                warnRendering(element, message, `已识别 ${entries.length} 个图片标记，但在酒馆格式化结果中找不到可挂载按钮的位置。`);
                continue;
            }
            if (display.slots.length < entries.length) {
                warnRendering(element, message, `已挂载 ${display.slots.length}/${entries.length} 个图片按钮；其余标记被显示规则隐藏、复制或转换。`);
            }
            else
                warnings.delete(element);
            // Validate every placeholder before moving any existing controls into the new display.
            display.slots.forEach(({ marker, key, historyKey, placeholder }) => {
                let control = images.get(key);
                if (!control) {
                    control = imageSlot(marker, message, key, historyKey);
                    images.set(key, control);
                }
                control.closePreview();
                placeholder.replaceWith(control.slot);
                state.slots.push(control.slot);
            });
            element.replaceChildren(...Array.from(display.formatted.childNodes));
            display.slots.forEach(({ key }) => images.get(key)?.refreshTheme());
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
    const themeObserver = new MutationObserver(() => images.forEach(control => control.refreshTheme()));
    for (const element of [document.documentElement, document.body]) {
        themeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
    window.addEventListener('storage', schedule, { signal });
    schedule();
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearTimeout(timer);
        observer.disconnect();
        themeObserver.disconnect();
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
