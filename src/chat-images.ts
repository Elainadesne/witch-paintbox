import { formatChatText, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { parseImageMarkers, type ImageMarker } from './image-markers.js';
import { loadImageSettings } from './image-settings.js';
import { loadModelSettings } from './model-settings.js';
import { generateImage } from './novelai.js';
import { createChatImageView } from './chat-image-view.js';

type AssistantMessage = ReturnType<typeof readAssistantMessages>[number];

interface RenderedMessage extends AssistantMessage {
  slots: HTMLElement[];
}

interface ImageControl {
  message: AssistantMessage;
  slot: HTMLElement;
  closePreview(): void;
  dispose(): void;
}

/** Hidden or transformed markers must not suppress the other buttons in a floor. */
function prepareImageDisplay(message: AssistantMessage, entries: Array<{ marker: ImageMarker; key: string }>) {
  let prefix: string;
  do { prefix = `WITCHPAINTBOX${crypto.getRandomValues(new Uint32Array(2)).join('X')}MARK`; }
  while (message.text.includes(prefix));
  let candidates = entries.map(entry => ({ ...entry, token: `${prefix}${entry.marker.start}END` }));
  while (candidates.length) {
    let cursor = 0;
    const parts: string[] = [];
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
      let found: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(entry.token)) continue;
        if (found || node.parentElement?.closest('code, pre, a, button, textarea, select, option, script, style')) return [];
        found = node as Text;
      }
      if (!found) return [];
      const offset = found.data.indexOf(entry.token);
      if (found.data.indexOf(entry.token, offset + entry.token.length) !== -1) return [];
      // A beautifier may also copy its content into attributes or comments.
      // Only commit a token which occurs exactly once in the complete display.
      if (html.split(entry.token).length !== 2) return [];
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
    const byNode = new Map<Text, typeof slots>();
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
export function bindChatImages(signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const rendered = new Map<HTMLElement, RenderedMessage>();
  // Keep requests and images across native DOM replacement and streamed text appends.
  const images = new Map<string, ImageControl>();
  const warnings = new WeakMap<HTMLElement, { text: string; reason: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function warnRendering(element: HTMLElement, message: AssistantMessage, reason: string): void {
    const previous = warnings.get(element);
    if (previous?.text === message.text && previous.reason === reason) return;
    warnings.set(element, { text: message.text, reason });
    // Do not print chat content, image prompts, or connection settings.
    console.warn(`[魔女画匣] 第 ${message.messageId + 1} 楼：${reason}`);
  }

  function sameMessage(a: AssistantMessage, b: AssistantMessage): boolean {
    return a.scope === b.scope && a.chatId === b.chatId && a.messageId === b.messageId
      && (a.swipeId ?? 0) === (b.swipeId ?? 0);
  }

  function markerEntries(message: AssistantMessage): Array<{ marker: ImageMarker; key: string }> {
    const markers = parseImageMarkers(message.text);
    const counts = new Map<string, number>();
    markers.forEach(marker => counts.set(marker.raw, (counts.get(marker.raw) ?? 0) + 1));
    const occurrences = new Map<string, number>();
    return markers.map(marker => {
      const occurrence = occurrences.get(marker.raw) ?? 0;
      occurrences.set(marker.raw, occurrence + 1);
      // If identical blocks are inserted/deleted, their old positions are ambiguous.
      return { marker, key: JSON.stringify([message.scope, message.chatId, message.messageId, message.swipeId ?? 0,
        marker.raw, counts.get(marker.raw), occurrence]) };
    });
  }

  function isCurrent(message: AssistantMessage, key: string): boolean {
    try {
      if (stopped || !loadModelSettings().parseImageMarkers) return false;
      const current = readAssistantMessages().find(item => sameMessage(item, message));
      return Boolean(current && markerEntries(current).some(entry => entry.key === key));
    } catch { return false; }
  }

  function clearImages(): void {
    images.forEach(control => control.dispose());
    images.clear();
  }

  function imageSlot(marker: ImageMarker, message: AssistantMessage, key: string): ImageControl {
    const controls = new AbortController();
    const { slot, button, cancel, status, canvas, preview, image, placeholder, download, closePreview } = createChatImageView(marker.summary, controls.signal);
    let request: AbortController | null = null;
    let url = '';
    let phase: 'queued' | 'generating' = 'queued';
    cancel.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      request?.abort();
    }, { signal: controls.signal });
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (request || !slot.isConnected || !isCurrent(message, key)
        || slot.closest('.mes')?.querySelector('textarea.edit_textarea')) return;
      const controller = new AbortController();
      request = controller;
      button.disabled = true;
      cancel.hidden = false;
      phase = 'queued';
      status.dataset.error = 'false';
      status.textContent = '正在加入队列…';
      try {
        const settings = loadImageSettings();
        if (!url) slot.style.setProperty('--image-ratio', String(settings.parameters.width / settings.parameters.height));
        canvas.hidden = false;
        canvas.dataset.busy = 'true';
        // The model contributes only the scene. Artist positives and negatives belong to the plugin.
        const positive = [marker.prompt, settings.positive].filter(text => text.trim()).join(', ');
        const result = await generateImage(settings.connection, settings.parameters, positive, settings.negative, controller.signal, progress => {
          if (controls.signal.aborted || controller.signal.aborted) return;
          if (!isCurrent(message, key)) { controller.abort(); return; }
          phase = progress.state;
          canvas.dataset.phase = phase;
          button.textContent = phase === 'queued' ? '已加入队列' : '正在绘制…';
          cancel.textContent = phase === 'queued' ? '取消排队' : '取消等待';
          status.textContent = progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在绘制…';
        });
        // A native re-render can temporarily detach the slot without invalidating its request.
        if (controller.signal.aborted || controls.signal.aborted || !isCurrent(message, key)) return;
        const nextUrl = URL.createObjectURL(result.blob);
        if (url) URL.revokeObjectURL(url);
        url = nextUrl;
        image.src = download.href = url;
        slot.style.setProperty('--image-ratio', String(settings.parameters.width / settings.parameters.height));
        preview.hidden = download.hidden = false;
        placeholder.hidden = true;
        download.download = `witch-paintbox-${result.seed}.png`;
        status.textContent = '绘制完成 · 点击图片放大';
        image.title = `种子 ${result.seed}`;
      } catch (error) {
        if (controls.signal.aborted) return;
        status.dataset.error = String(!controller.signal.aborted);
        status.textContent = controller.signal.aborted
          ? phase === 'queued' ? '已取消排队。' : '已取消等待，服务端任务可能仍在继续。'
          : error instanceof Error ? error.message : '生图未完成，请稍后重试。';
      } finally {
        request = null;
        button.disabled = false;
        button.textContent = url ? '重新绘制' : '生成图片';
        cancel.hidden = true;
        canvas.dataset.busy = 'false';
        delete canvas.dataset.phase;
        if (!url) canvas.hidden = true;
      }
    }, { signal: controls.signal });
    return {
      message, slot, closePreview,
      dispose() { controls.abort(); request?.abort(); if (url) URL.revokeObjectURL(url); },
    };
  }

  function render(): void {
    if (stopped) return;
    let messages: ReturnType<typeof readAssistantMessages>;
    let enabled: boolean;
    try {
      messages = readAssistantMessages();
      enabled = loadModelSettings().parseImageMarkers;
    } catch {
      clearImages();
      rendered.forEach(state => state.slots.forEach(slot => slot.remove()));
      rendered.clear();
      return;
    }
    const byId = new Map(messages.map(message => [message.messageId, message]));
    const entriesById = new Map<number, ReturnType<typeof markerEntries>>();
    const entriesFor = (message: AssistantMessage) => {
      let entries = entriesById.get(message.messageId);
      if (!entries) {
        try { entries = markerEntries(message); } catch { entries = []; }
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
          try { element.innerHTML = formatChatText(current.text, current.messageId); } catch { /* Keep native display if unavailable. */ }
        }
      }
    }
    if (!enabled) return;
    for (const block of Array.from(document.querySelectorAll<HTMLElement>('#chat .mes[mesid]'))) {
      if (!block.isConnected || block.parentElement?.closest('.mes')) continue;
      const element = block.querySelector<HTMLElement>('.mes_text');
      if (!element) continue;
      const messageId = Number(block.getAttribute('mesid'));
      const message = byId.get(messageId);
      if (!message || block.querySelector('textarea.edit_textarea')) continue;
      const previous = rendered.get(element);
      if (previous?.text === message.text && sameMessage(previous, message)
        && previous.slots.every(slot => slot.isConnected && element.contains(slot))) continue;
      if (previous) rendered.delete(element);
      const entries = entriesFor(message);
      if (!entries.length) {
        if (/<img\s*>/i.test(message.text)) warnRendering(element, message, '未解析到有效图片标记；请检查标记格式或其所在的代码/HTML 区域。');
        continue;
      }
      const state: RenderedMessage = { ...message, slots: [] };
      let display: ReturnType<typeof prepareImageDisplay>;
      try { display = prepareImageDisplay(message, entries); }
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
      } else warnings.delete(element);
      // Validate every placeholder before moving any existing controls into the new display.
      display.slots.forEach(({ marker, key, placeholder }) => {
        let control = images.get(key);
        if (!control) {
          control = imageSlot(marker, message, key);
          images.set(key, control);
        }
        control.closePreview();
        placeholder.replaceWith(control.slot);
        state.slots.push(control.slot);
      });
      element.replaceChildren(...Array.from(display.formatted.childNodes));
      rendered.set(element, state);
    }
  }

  function schedule(): void {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; render(); }, 0);
  }
  let stopWatching = () => {};
  try { stopWatching = watchChatRendering(schedule); } catch { /* The DOM observer can still follow native re-renders. */ }
  const observer = new MutationObserver(schedule);
  observer.observe(document.getElementById('chat') ?? document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
  window.addEventListener('storage', schedule, { signal });
  schedule();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    stopWatching();
    let current: ReturnType<typeof readAssistantMessages> = [];
    try { current = readAssistantMessages(); } catch { /* Host is already unloading. */ }
    clearImages();
    for (const [element, state] of rendered) {
      if (element.isConnected && !element.closest('.mes')?.querySelector('textarea.edit_textarea')
        && current.some(message => sameMessage(message, state) && message.text === state.text)) {
        try { element.innerHTML = formatChatText(state.text, state.messageId); }
        catch { state.slots.forEach(slot => slot.remove()); }
      }
    }
    rendered.clear();
  };
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}
