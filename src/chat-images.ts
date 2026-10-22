import { formatChatText, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { parseImageMarkers, type ImageMarker } from './image-markers.js';
import { loadImageSettings } from './image-settings.js';
import { loadModelSettings } from './model-settings.js';
import { generateImage } from './novelai.js';

interface RenderedMessage {
  chatId: string;
  messageId: number;
  text: string;
  slots: HTMLElement[];
  dispose: (() => void)[];
}

/** Render-only controls: stored chat text always contains the original literal markers. */
export function bindChatImages(signal: AbortSignal): () => void {
  const rendered = new Map<HTMLElement, RenderedMessage>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function dispose(state: RenderedMessage): void { state.dispose.forEach(cleanup => cleanup()); }

  function imageSlot(marker: ImageMarker, state: RenderedMessage): HTMLElement {
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
    const button = shadow.querySelector('button')!;
    const status = shadow.querySelector('p')!;
    const image = shadow.querySelector('img')!;
    const download = shadow.querySelector('a')!;
    button.textContent = `生成图片 · ${marker.summary}`;
    image.alt = marker.summary;
    let request: AbortController | null = null;
    let url = '';
    const controls = new AbortController();
    state.dispose.push(() => { controls.abort(); request?.abort(); if (url) URL.revokeObjectURL(url); });
    button.addEventListener('click', async () => {
      if (request || !slot.isConnected) return;
      const controller = new AbortController();
      request = controller;
      button.disabled = true;
      status.textContent = '正在生成图片…';
      try {
        const settings = loadImageSettings();
        // The model contributes only the scene. Artist positives and negatives belong to the plugin.
        const positive = [marker.prompt, settings.positive].filter(text => text.trim()).join(', ');
        const result = await generateImage(settings.connection, settings.parameters, positive, settings.negative, controller.signal);
        if (controller.signal.aborted || !slot.isConnected) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(result.blob);
        image.src = download.href = url;
        image.hidden = download.hidden = false;
        download.download = `witch-paintbox-${result.seed}.png`;
        button.textContent = `再次生成 · ${marker.summary}`;
        status.textContent = `生成完成 · 种子 ${result.seed}`;
      } catch (error) {
        if (!controller.signal.aborted) status.textContent = (error as Error).message;
      } finally {
        request = null;
        button.disabled = false;
      }
    }, { signal: controls.signal });
    return slot;
  }

  function render(): void {
    if (stopped) return;
    let messages: ReturnType<typeof readAssistantMessages>;
    let enabled: boolean;
    try {
      messages = readAssistantMessages();
      enabled = loadModelSettings().parseImageMarkers;
    } catch {
      rendered.forEach(dispose);
      rendered.clear();
      return;
    }
    const byId = new Map(messages.map(message => [message.messageId, message]));
    for (const [element, state] of rendered) {
      const current = byId.get(state.messageId);
      if (!element.isConnected || current?.chatId !== state.chatId || current.text !== state.text || !enabled
        || state.slots.some(slot => !element.contains(slot))) {
        dispose(state);
        rendered.delete(element);
        if (!enabled && element.isConnected && current?.chatId === state.chatId && current.text === state.text) {
          try { element.innerHTML = formatChatText(current.text, current.messageId); } catch { /* Keep native display if unavailable. */ }
        }
      }
    }
    if (!enabled) return;
    for (const block of Array.from(document.querySelectorAll<HTMLElement>('#chat > .mes[mesid]'))) {
      const element = block.querySelector<HTMLElement>('.mes_text');
      if (!element) continue;
      const messageId = Number(block.getAttribute('mesid'));
      const message = byId.get(messageId);
      if (!message || block.querySelector('textarea.edit_textarea')) continue;
      const previous = rendered.get(element);
      if (previous?.text === message.text && previous.chatId === message.chatId && previous.slots.every(slot => slot.isConnected && element.contains(slot))) continue;
      if (previous) { dispose(previous); rendered.delete(element); }
      let markers: ImageMarker[];
      try { markers = parseImageMarkers(message.text); }
      catch { continue; }
      if (!markers.length) continue;
      const state: RenderedMessage = { ...message, slots: [], dispose: [] };
      let prefix: string;
      do { prefix = `WITCHPAINTBOX${crypto.getRandomValues(new Uint32Array(2)).join('X')}MARK`; }
      while (message.text.includes(prefix));
      let cursor = 0;
      const parts: string[] = [];
      const tokens = markers.map((marker, index) => {
        const token = `${prefix}${index}END`;
        parts.push(message.text.slice(cursor, marker.start), token);
        cursor = marker.end;
        return token;
      });
      parts.push(message.text.slice(cursor));
      const formatted = document.createElement('div');
      try { formatted.innerHTML = formatChatText(parts.join(''), messageId); }
      catch { continue; }
      let valid = true;
      for (let index = 0; index < tokens.length; index++) {
        const walker = document.createTreeWalker(formatted, NodeFilter.SHOW_TEXT);
        let found: Text | null = null;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.textContent?.includes(tokens[index])) {
            if (found) { valid = false; break; }
            found = node as Text;
          }
        }
        if (!valid || !found || found.parentElement?.closest('code, pre, a, script, style')) { valid = false; break; }
        const offset = found.data.indexOf(tokens[index]);
        if (found.data.indexOf(tokens[index], offset + tokens[index].length) !== -1) { valid = false; break; }
        const trailing = found.splitText(offset);
        trailing.splitText(tokens[index].length);
        const slot = imageSlot(markers[index], state);
        trailing.replaceWith(slot);
        state.slots.push(slot);
      }
      if (!valid) { dispose(state); continue; }
      element.replaceChildren(...Array.from(formatted.childNodes));
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
  observer.observe(document.getElementById('chat') ?? document.body, { childList: true, subtree: true });
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
    for (const [element, state] of rendered) {
      dispose(state);
      if (element.isConnected && current.some(message => message.chatId === state.chatId
        && message.messageId === state.messageId && message.text === state.text)) {
        try { element.innerHTML = formatChatText(state.text, state.messageId); }
        catch { state.slots.forEach(slot => slot.remove()); }
      }
    }
    rendered.clear();
  };
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}
