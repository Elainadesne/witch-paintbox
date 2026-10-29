import { imageChatContext, readAssistantMessages, watchChatRendering, type ImageDisplayChange } from './chat-host.js';
import { hasPendingFrontendFrame, iframeNarrativeRoot, locateImageInsertionPoints, locateImageMarkers, primaryNarrativeContainer } from './chat-image-placement.js';
import type { ImageMarker } from './image-markers.js';
import { loadImageSettings } from './image-settings.js';
import { loadModelSettings } from './model-settings.js';
import { expectedImageSize, generateConfiguredImage, imageSettingsForMarker } from './image-provider.js';
import { createChatImageView } from './chat-image-view.js';
import { createImageGallery, type GalleryImage } from './image-gallery.js';
import { loadImageHistory, saveImageHistory, deleteImageHistory, onImageHistoryChanged, historyWasDeleted, type ImageHistoryChange, type ImageHistoryEntry } from './image-history.js';
import { markerEntries, type MarkerEntry } from './image-marker-history.js';
import { imageFileExtension } from './raster-image.js';
import { frameDocument, frontendFrames } from './frontend-frames.js';
import { watchChatImageLayout } from './chat-image-layout.js';
import { automaticImages } from './automatic-images.js';
import { currentPreferences } from './settings.js';
import { emitPetEvent, petEnd, petFault, petTaskId } from './pet-events.js';
import { floorTarget } from './pet-targets.js';

type AssistantMessage = ReturnType<typeof readAssistantMessages>[number];

interface ImageControl {
  message: AssistantMessage;
  slot: HTMLElement;
  closePreview(): void;
  refreshTheme(): void;
  generateAutomatically(signal: AbortSignal): Promise<void>;
  removeHistory(change: ImageHistoryChange): void;
  dispose(): void;
}

interface PendingInsertion {
  message: AssistantMessage;
  previousText: string;
  sourceOffset: number;
}

/** Render-only controls: stored chat text always contains the original literal markers. */
export function bindChatImages(signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const originals = new WeakMap<HTMLElement, DocumentFragment>();
  // Keep requests and images across native DOM replacement and streamed text appends.
  const images = new Map<string, ImageControl>();
  const insertions = new Map<string, PendingInsertion>();
  const pendingContainers = new Set<HTMLElement>();
  const warnings = new WeakMap<HTMLElement, { text: string; reason: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const observedFrames = new Map<HTMLIFrameElement, { doc: Document | null; dispose(): void }>();
  const chatElement = document.getElementById('chat') ?? document.body;
  const layout = watchChatImageLayout(chatElement, schedule);
  const automatic = automaticImages({
    mounted: ({ entry, message }) => {
      const slot = images.get(entry.key)?.slot;
      return Boolean(slot && isSlotConnected(slot) && isCurrent(message, entry.key));
    },
    async generate({ entry }, signal) { await images.get(entry.key)?.generateAutomatically(signal); },
  });
  const stopHistory = onImageHistoryChanged(change => images.forEach(control => control.removeHistory(change)));

  function containsAcrossFrames(root: Node, node: Node | null | undefined): boolean {
    let current: Node | null | undefined = node;
    while (current) {
      if (!current.isConnected) return false;
      if (root.contains(current)) return true;
      try { current = current.ownerDocument?.defaultView?.frameElement ?? null; }
      catch { return false; }
    }
    return false;
  }

  function isSlotConnected(slot: HTMLElement): boolean {
    return slot.isConnected && containsAcrossFrames(document.documentElement, slot);
  }

  function closestFloor(node: Node): Element | null {
    let current: Node | null = node;
    while (current) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        const mes = (current as Element).closest('.mes');
        if (mes) return mes;
      }
      current = current.ownerDocument?.defaultView?.frameElement ?? null;
    }
    return null;
  }

  function warnRendering(element: HTMLElement, message: AssistantMessage, reason: string): void {
    const previous = warnings.get(element);
    if (previous?.text === message.text && previous.reason === reason) return;
    warnings.set(element, { text: message.text, reason });
    // Do not print chat content, image prompts, or connection settings.
    console.warn(`[魔女画匣] 第 ${message.messageId + 1} 楼：${reason}`);
  }

  function sameMessage(a: AssistantMessage, b: AssistantMessage): boolean {
    return a.scope === b.scope && a.chatId === b.chatId && a.messageId === b.messageId
      && (a.swipeId ?? 0) === (b.swipeId ?? 0) && a.historyId === b.historyId && a.turnId === b.turnId;
  }

  function isCurrent(message: AssistantMessage, key: string): boolean {
    try {
      if (stopped || !loadModelSettings().parseImageMarkers) return false;
      const current = readAssistantMessages().find(item => sameMessage(item, message));
      return Boolean(current && markerEntries(current).some(entry => entry.key === key));
    } catch { return false; }
  }

  function restoreSlot(slot: HTMLElement): void {
    const original = originals.get(slot);
    if (original) slot.replaceWith(original);
    else slot.remove();
    originals.delete(slot);
  }

  function cleanPendingContainers(): void {
    for (const container of pendingContainers) {
      if (!isSlotConnected(container)) pendingContainers.delete(container);
      else if (!container.querySelector('.witch-paintbox-image')) {
        container.firstElementChild?.remove();
        // Disabling parsing restores only our literal fragments, never the full floor.
        container.replaceWith(...Array.from(container.childNodes));
        pendingContainers.delete(container);
      }
    }
  }

  function clearImages(): void {
    layout.update(new Set());
    images.forEach(control => { restoreSlot(control.slot); control.dispose(); });
    images.clear();
    insertions.clear();
    cleanPendingContainers();
  }

  function receiveInsertions(messageId: number, change: ImageDisplayChange): void {
    // Bind the private notification to the complete current identity synchronously.
    const message = readAssistantMessages().find(item => item.messageId === messageId && item.text === change.text);
    if (!message) return;
    const entries = markerEntries(message);
    const keys = new Set(entries.map(entry => entry.key));
    const addedStarts = new Set(change.added.map(marker => marker.start));
    const before = markerEntries({ ...message, text: change.previousText });
    const existing = entries.filter(entry => !addedStarts.has(entry.marker.start));
    const replacement = before.length === existing.length && before.every((entry, i) => entry.marker.raw === existing[i].marker.raw)
      ? new Map(before.map((entry, i) => [entry.key, existing[i]])) : new Map<string, MarkerEntry>();
    // A known pure insertion preserves the old markers' order. If a duplicate
    // changes their occurrence keys, keep each existing frame at its exact node.
    for (const [key, control] of images) {
      if (sameMessage(control.message, message) && !keys.has(key)) {
        const nextEntry = replacement.get(key);
        const pending = insertions.get(key);
        if (nextEntry && pending) {
          insertions.set(nextEntry.key, { ...pending, message });
          insertions.delete(key);
        }
        if (nextEntry && isSlotConnected(control.slot)) {
          const next = controlFor(nextEntry, message);
          const original = originals.get(control.slot);
          if (original) originals.set(next.slot, original);
          control.slot.replaceWith(next.slot);
          originals.delete(control.slot);
          next.refreshTheme();
        } else restoreSlot(control.slot);
        control.dispose();
        images.delete(key);
      }
    }
    for (const marker of change.added) {
      const entry = entries.find(item => item.marker.start === marker.start && item.marker.raw === marker.raw);
      if (entry) insertions.set(entry.key, { message, previousText: change.previousText, sourceOffset: marker.sourceOffset });
    }
  }

  function controlFor(entry: MarkerEntry, message: AssistantMessage): ImageControl {
    let control = images.get(entry.key);
    if (!control) {
      control = imageSlot(entry.marker, message, entry.key, entry.historyKey);
      control.slot.dataset.wpSlot = entry.key;
      images.set(entry.key, control);
    }
    return control;
  }

  function rememberInsertedText(entry: MarkerEntry, slot: HTMLElement): void {
    if (originals.has(slot)) return;
    const doc = slot.ownerDocument ?? document;
    const fragment = doc.createDocumentFragment();
    fragment.append(doc.createTextNode(`\n\n${entry.marker.raw}\n\n`));
    originals.set(slot, fragment);
  }

  function mountPendingInsertions(element: HTMLElement, message: AssistantMessage, entries: MarkerEntry[]): void {
    const pending = entries.filter(entry => insertions.has(entry.key));
    const groups = new Map<string, MarkerEntry[]>();
    for (const entry of pending) {
      const original = insertions.get(entry.key)!.previousText;
      const group = groups.get(original) ?? [];
      group.push(entry);
      groups.set(original, group);
    }
    for (const [original, group] of groups) {
      let points: ReturnType<typeof locateImageInsertionPoints> = [];
      try {
        points = locateImageInsertionPoints(element, message.messageId, original,
          group.map(entry => insertions.get(entry.key)!.sourceOffset));
      } catch { /* A changed or inaccessible display uses the local fallback below. */ }
      for (const { offset, range } of points) {
        const atPoint = group.filter(entry => insertions.get(entry.key)?.sourceOffset === offset);
        const doc = range.startContainer.ownerDocument ?? document;
        const fragment = doc.createDocumentFragment();
        for (const entry of atPoint) {
          const control = controlFor(entry, message);
          rememberInsertedText(entry, control.slot);
          fragment.append(control.slot);
        }
        try {
          range.insertNode(fragment);
          for (const entry of atPoint) {
            insertions.delete(entry.key);
            images.get(entry.key)?.refreshTheme();
          }
          emitPetEvent({ type: 'frames', floor: message.messageId, targets: atPoint.flatMap(entry => images.get(entry.key)?.slot ?? []) });
        } catch { /* The controls remain available to the fallback, including ongoing requests. */ }
      }
    }
    const unresolved = pending.filter(entry => insertions.has(entry.key));
    if (!unresolved.length) return;
    if (hasPendingFrontendFrame(element)) return;
    const target = primaryNarrativeContainer(element);
    const doc = target.ownerDocument ?? document;
    let container = [...pendingContainers].find(item => item.parentElement === target);
    if (!container) {
      container = doc.createElement('div');
      container.className = 'witch-paintbox-pending';
      container.dataset.preserveHtml = '1';
      const note = doc.createElement('small');
      note.textContent = '配图已保存 · 暂未定位到正文位置，可先在此生成图片。';
      container.append(note);
      const anchor = target.querySelector('.wlog-report-panel, .auto-system-panel');
      if (anchor && anchor.parentElement === target) target.insertBefore(container, anchor);
      else target.append(container);
      pendingContainers.add(container);
    }
    let previous: ChildNode | null = container.firstChild;
    const placed: HTMLElement[] = [];
    for (const entry of unresolved) {
      const control = controlFor(entry, message);
      rememberInsertedText(entry, control.slot);
      const next = previous?.nextSibling ?? null;
      if (next !== control.slot) { container.insertBefore(control.slot, next); placed.push(control.slot); }
      previous = control.slot;
      control.refreshTheme();
    }
    if (placed.length) emitPetEvent({ type: 'frames', floor: message.messageId, targets: placed });
  }

  function imageSlot(marker: ImageMarker, message: AssistantMessage, key: string, historyKey: string | null): ImageControl {
    const controls = new AbortController();
    const { slot, root, button, buttonLabel, regenerate, cancel, status, canvas, preview, image, placeholder, download, refreshTheme, setImageSize, veil } = createChatImageView(marker.summary, controls.signal);
    try {
      const settings = imageSettingsForMarker(loadImageSettings(), marker);
      const { width, height } = expectedImageSize(settings);
      setImageSize(width, height);
    } catch { /* A saved image can still provide its own dimensions. */ }
    let request: AbortController | null = null;
    let history: GalleryImage[] = [];
    const saves = new Map<string, Promise<void>>();
    let selectedId: string | null = null;
    let phase: 'queued' | 'generating' = 'queued';
    let historyLoaded = false;
    let historyAvailable = false;
    let deletedBefore = 0;
    const deletedIds = new Set<string>();
    const deleted = (entry: ImageHistoryEntry) => entry.createdAt < deletedBefore || deletedIds.has(entry.id);
    const gallery = createImageGallery(marker.summary, controls.signal, {
      onSelect(id) { selectedId = id; showSelected(); },
      async onDelete(id) {
        const index = history.findIndex(item => item.entry.id === id);
        if (index < 0) return;
        await saves.get(id)?.catch(() => {});
        // A save can time out after committing; deleting a missing record is safe.
        if (historyKey) await deleteImageHistory(id);
        if (controls.signal.aborted) return;
        const removed = history.find(item => item.entry.id === id);
        history = history.filter(item => item.entry.id !== id);
        if (selectedId === id) selectedId = history[Math.min(index, history.length - 1)]?.entry.id ?? null;
        showSelected();
        if (removed) URL.revokeObjectURL(removed.url);
        if (!request) {
          status.dataset.error = 'false';
          status.textContent = history.length ? `已删除图片 · 剩余 ${history.length} 张` : '图片已删除，可重新生成。';
        }
      },
    });
    root.append(gallery.element);

    function syncGenerationButtons(): void {
      const busy = Boolean(request);
      button.disabled = regenerate.disabled = !historyLoaded || busy;
      slot.dataset.busy = String(busy);
      buttonLabel.textContent = busy ? phase === 'queued' ? '已加入队列' : '正在绘制…'
        : history.length ? '再绘一张' : '生成图片';
      regenerate.textContent = !historyLoaded ? '读取中…' : busy ? phase === 'queued' ? '排队中' : '绘制中'
        : history.length ? '再次生图' : '生成图片';
      regenerate.setAttribute('aria-label', `${regenerate.textContent}：${marker.summary}`);
    }

    function showSelected(): void {
      const selected = history.find(item => item.entry.id === selectedId);
      preview.hidden = download.hidden = !selected;
      placeholder.hidden = Boolean(selected);
      canvas.hidden = !selected && !request;
      if (selected) {
        image.src = download.href = selected.url;
        image.title = selected.entry.seed === undefined ? selected.entry.parameters.model : `种子 ${selected.entry.seed}`;
        download.download = `witch-paintbox-${selected.entry.seed ?? selected.entry.id}.${imageFileExtension(selected.entry.blob)}`;
        setImageSize(selected.entry.parameters.width, selected.entry.parameters.height);
      } else {
        image.removeAttribute('src');
        download.removeAttribute('href');
      }
      syncGenerationButtons();
      gallery.setImages(history, selectedId);
    }

    syncGenerationButtons();
    status.textContent = '正在读取图片历史…';
    const historyReady = (historyKey ? loadImageHistory(historyKey) : Promise.resolve([])).then(entries => {
      if (controls.signal.aborted) return;
      historyAvailable = true;
      history = entries.filter(entry => !deleted(entry)).map(entry => ({ entry, url: URL.createObjectURL(entry.blob) }));
      selectedId = history.at(-1)?.entry.id ?? null;
      showSelected();
      if (!request) status.textContent = historyKey
        ? history.length ? `已恢复 ${history.length} 张图片 · 点击查看历史` : ''
        : '本楼层缺少唯一时间标识，图片仅保留在当前页面，可下载保存。';
    }).catch(error => {
      if (controls.signal.aborted) return;
      status.dataset.error = 'true';
      status.textContent = error instanceof Error ? error.message : '图片历史读取失败。';
    }).finally(() => { historyLoaded = true; syncGenerationButtons(); });

    preview.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (history.length) gallery.open();
    }, { signal: controls.signal });
    cancel.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      request?.abort();
    }, { signal: controls.signal });
    async function requestGeneration(autoSignal?: AbortSignal): Promise<void> {
      if (autoSignal?.aborted || request || !isSlotConnected(slot) || !isCurrent(message, key)
        || closestFloor(slot)?.querySelector('textarea.edit_textarea')) return;
      const controller = new AbortController();
      const cancelAutomatic = () => controller.abort();
      autoSignal?.addEventListener('abort', cancelAutomatic, { once: true });
      request = controller;
      cancel.hidden = false;
      phase = 'queued';
      syncGenerationButtons();
      status.dataset.error = 'false';
      status.textContent = '正在加入队列…';
      const pet = petTaskId();
      const source = autoSignal ? 'auto' : 'floor';
      const endPet = petEnd();
      const petImage = { type: 'end', id: pet, task: 'image', source, floor: message.messageId } as const;
      try {
        const settings = imageSettingsForMarker(loadImageSettings(), marker);
        const parameters = expectedImageSize(settings);
        emitPetEvent({ type: 'image', id: pet, source, phase: 'start', provider: settings.provider, floor: message.messageId,
          turn: message.turnId !== null, summary: marker.summary, again: history.length > 0, width: parameters.width, height: parameters.height });
        controller.signal.throwIfAborted();
        await historyReady;
        controller.signal.throwIfAborted();
        if (!isCurrent(message, key)) { controller.abort(); controller.signal.throwIfAborted(); }
        if (!history.length) setImageSize(parameters.width, parameters.height);
        canvas.hidden = false;
        canvas.dataset.busy = 'true';
        const result = await generateConfiguredImage(settings, marker.prompt, controller.signal, progress => {
          if (controls.signal.aborted || controller.signal.aborted) return;
          if (!isCurrent(message, key)) { controller.abort(); return; }
          if (autoSignal && progress.state === 'generating') {
            const preferences = currentPreferences();
            if (!preferences.autoGenerateImages || imageChatContext()?.latestMessageId !== message.messageId) {
              controller.abort(); return;
            }
          }
          phase = progress.state;
          canvas.dataset.phase = phase;
          syncGenerationButtons();
          cancel.textContent = phase === 'queued' ? '取消排队' : '取消等待';
          status.textContent = progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在绘制…';
          emitPetEvent({ type: 'image', id: pet, source, phase: progress.state, floor: message.messageId,
            position: progress.state === 'queued' ? progress.position : undefined, columns: progress.columns,
            width: parameters.width, height: parameters.height });
        }, settings.positive);
        // A native re-render can temporarily detach the slot without invalidating its request.
        if (controller.signal.aborted || controls.signal.aborted || !isCurrent(message, key)) {
          endPet({ ...petImage, result: 'dropped', paid: true, message: '' });
          return;
        }
        const entry: ImageHistoryEntry = {
          id: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`,
          ...result, markerKey: historyKey ?? key, createdAt: Date.now(),
          scenePrompt: marker.prompt,
          title: marker.summary, sourceName: imageChatContext()?.name,
        };
        const saving = historyKey ? saveImageHistory(entry) : Promise.resolve();
        saves.set(entry.id, saving);
        history.push({ entry, url: URL.createObjectURL(result.blob) });
        selectedId = entry.id;
        showSelected();
        endPet({ ...petImage, result: 'done', message: '', picture: {
          blob: result.blob, width: result.parameters.width, height: result.parameters.height, target: () => floorTarget(slot), veil,
        } });
        cancel.hidden = true;
        status.textContent = '绘制完成，正在保存图片历史…';
        try {
          await saving;
          const saved = historyKey
            ? `已保存 ${history.length} 张图片 · 点击查看历史`
            : '本楼层缺少唯一时间标识，图片仅保留在当前页面，可下载保存。';
          if (!controls.signal.aborted) status.textContent = saved;
          emitPetEvent({ type: 'history', id: pet, saved: true, pageOnly: !historyKey, message: saved });
        } catch (error) {
          const failed = `图片已生成，但历史未保存：${error instanceof Error ? error.message : '浏览器存储不可用。'}`;
          emitPetEvent({ type: 'history', id: pet, saved: false, message: failed });
          if (!controls.signal.aborted) {
            status.dataset.error = 'true';
            status.textContent = failed;
          }
        } finally { saves.delete(entry.id); }
      } catch (error) {
        if (controls.signal.aborted) {
          endPet({ ...petImage, result: 'dropped', serverMayContinue: phase !== 'queued', message: '' });
          return;
        }
        status.dataset.error = String(!controller.signal.aborted);
        status.textContent = controller.signal.aborted
          ? phase === 'queued' ? '已取消排队。' : '已取消等待，服务端任务可能仍在继续。'
          : error instanceof Error ? error.message : '生图未完成，请稍后重试。';
        endPet({ ...petImage, result: controller.signal.aborted ? 'cancelled' : 'failed', message: status.textContent ?? '',
          fault: controller.signal.aborted ? undefined : petFault(error), serverMayContinue: controller.signal.aborted && phase !== 'queued' });
      } finally {
        endPet({ ...petImage, result: 'dropped', message: '' });
        autoSignal?.removeEventListener('abort', cancelAutomatic);
        request = null;
        syncGenerationButtons();
        cancel.hidden = true;
        canvas.dataset.busy = 'false';
        delete canvas.dataset.phase;
        if (!history.length) canvas.hidden = true;
      }
    }
    const clickGenerate = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); void requestGeneration(); };
    button.addEventListener('click', clickGenerate, { signal: controls.signal });
    regenerate.addEventListener('click', clickGenerate, { signal: controls.signal });
    return {
      message, slot, closePreview: gallery.close, refreshTheme,
      async generateAutomatically(signal) {
        await historyReady;
        if (signal.aborted || !historyAvailable || history.length || request) return;
        await requestGeneration(signal);
      },
      removeHistory(change) {
        change.deletedIds?.forEach(id => deletedIds.add(id));
        deletedBefore = Math.max(deletedBefore, change.before ?? 0);
        const removed = history.filter(item => historyWasDeleted(item.entry, change));
        if (!removed.length) return;
        history = history.filter(item => !historyWasDeleted(item.entry, change));
        if (!history.some(item => item.entry.id === selectedId)) selectedId = history.at(-1)?.entry.id ?? null;
        showSelected();
        removed.forEach(item => URL.revokeObjectURL(item.url));
        if (!request) status.textContent = history.length ? `剩余 ${history.length} 张图片` : '本机图片已清理，可手动重新生成。';
      },
      dispose() { controls.abort(); request?.abort(); history.forEach(item => URL.revokeObjectURL(item.url)); history = []; },
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
      automatic.update([], false);
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
    for (const [key, pending] of insertions) {
      const current = byId.get(pending.message.messageId);
      if (!current || !sameMessage(current, pending.message) || !entriesFor(current).some(entry => entry.key === key)) {
        insertions.delete(key);
      }
    }
    for (const [key, control] of images) {
      const current = byId.get(control.message.messageId);
      if (!enabled || !current || !sameMessage(current, control.message)
        || !entriesFor(current).some(entry => entry.key === key)) {
        // Only restore a fragment while the original floor/marker is still current.
        if (current && sameMessage(current, control.message)
          && entriesFor(current).some(entry => entry.key === key)) restoreSlot(control.slot);
        else { control.slot.remove(); originals.delete(control.slot); }
        control.dispose();
        images.delete(key);
      }
    }
    cleanPendingContainers();
    observeFrames();
    const awaitingLayout = new Set<HTMLElement>();
    if (!enabled) { layout.update(awaitingLayout); automatic.update([], false); return; }
    for (const block of Array.from(document.querySelectorAll<HTMLElement>('#chat .mes[mesid]'))) {
      if (!block.isConnected || block.parentElement?.closest('.mes')) continue;
      const element = block.querySelector<HTMLElement>('.mes_text');
      if (!element) continue;
      const messageId = Number(block.getAttribute('mesid'));
      const message = byId.get(messageId);
      if (!message || block.querySelector('textarea.edit_textarea')) continue;
      const entries = entriesFor(message);
      if (!entries.length) {
        if (/<img\s*>/i.test(message.text)) warnRendering(element, message, '未解析到有效图片标记；请检查标记格式或其所在的代码/HTML 区域。');
        continue;
      }
      // Restore live slots if a frontend script cloned and replaced its container DOM.
      const entryByKey = new Map(entries.map(entry => [entry.key, entry]));
      const roots = [element, ...frontendFrames(element).map(frame => iframeNarrativeRoot(frame).root).filter((r): r is HTMLElement => Boolean(r))];
      for (const root of roots) {
        for (const clone of Array.from(root.querySelectorAll<HTMLElement>('.witch-paintbox-image[data-wp-slot]'))) {
          if (clone.shadowRoot) continue;
          const entry = entryByKey.get(clone.dataset.wpSlot ?? '');
          if (!entry) continue;
          const control = controlFor(entry, message);
          if (control.slot !== clone) {
            clone.replaceWith(control.slot);
            insertions.delete(entry.key);
            control.refreshTheme();
          }
        }
      }
      const mounted = entries.flatMap(entry => {
        const slot = images.get(entry.key)?.slot;
        return slot && containsAcrossFrames(element, slot) ? [slot] : [];
      });
      if (mounted.length === entries.length && !entries.some(entry => insertions.has(entry.key))) {
        warnings.delete(element);
        continue;
      }
      const pending = entries.filter(entry => {
        const slot = images.get(entry.key)?.slot;
        return !slot || !containsAcrossFrames(element, slot) || insertions.has(entry.key);
      });
      let placements: ReturnType<typeof locateImageMarkers> = [];
      try { placements = locateImageMarkers(element, messageId, pending); }
      catch {
        warnRendering(element, message, `已识别 ${entries.length} 个图片标记，但正文中的按钮定位失败。`);
      }
      for (const { entry, range } of placements) {
        const control = controlFor(entry, message);
        control.closePreview();
        if (isSlotConnected(control.slot)) {
          if (insertions.has(entry.key)) control.slot.remove();
          else restoreSlot(control.slot);
        }
        // Keep every unrelated node (iframes, event handlers and widget state) intact.
        const original = range.extractContents();
        range.insertNode(control.slot);
        originals.set(control.slot, original);
        insertions.delete(entry.key);
        control.refreshTheme();
      }
      mountPendingInsertions(element, message, entries);
      const count = entries.filter(entry => {
        const slot = images.get(entry.key)?.slot;
        return slot && containsAcrossFrames(element, slot);
      }).length;
      if (count < entries.length) {
        awaitingLayout.add(block);
        if (!hasPendingFrontendFrame(element)) {
          warnRendering(element, message, `已挂载 ${count}/${entries.length} 个图片按钮；其余标记尚未定位到可见正文，可能尚未布局或被显示规则隐藏、复制或转换。`);
        }
      } else warnings.delete(element);
    }
    layout.update(awaitingLayout);
    automatic.update(messages.flatMap(message => entriesFor(message).map(entry => ({ message, entry }))), enabled);
    cleanPendingContainers();
  }

  function observeFrames(): void {
    if (stopped) return;
    const frames = new Set(frontendFrames(document.getElementById('chat') ?? document.body));
    for (const [frame, watch] of observedFrames) {
      if (!frames.has(frame) || frameDocument(frame) !== watch.doc) {
        watch.dispose();
        observedFrames.delete(frame);
      }
    }
    for (const frame of frames) {
      if (observedFrames.has(frame)) continue;
      const doc = frameDocument(frame);
      const mutations = new MutationObserver(schedule);
      const theme = new MutationObserver(() => images.forEach(control => control.refreshTheme()));
      frame.addEventListener('load', schedule);
      if (doc?.documentElement) {
        mutations.observe(doc.documentElement, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['class', 'aria-busy', 'style', 'hidden', 'aria-hidden'],
        });
        doc.addEventListener('toggle', schedule, true);
        theme.observe(doc.documentElement, {
          subtree: true, attributes: true, attributeFilter: ['data-theme'],
        });
        if (doc.body) theme.observe(doc.body, { attributes: true, attributeFilter: ['class', 'style'] });
      }
      observedFrames.set(frame, { doc, dispose() {
        mutations.disconnect();
        theme.disconnect();
        frame.removeEventListener('load', schedule);
        doc?.removeEventListener('toggle', schedule, true);
      } });
    }
  }

  function schedule(): void {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; render(); }, 0);
  }
  let stopWatching = () => {};
  try {
    stopWatching = watchChatRendering((messageId, change, event) => {
      if (event === 'GENERATION_ENDED' || event === 'GENERATION_STOPPED') automatic.settled();
      try { if (messageId !== undefined && change) receiveInsertions(messageId, change); }
      finally { schedule(); }
    });
  } catch { /* The DOM observer can still follow native re-renders. */ }
  const observer = new MutationObserver(schedule);
  observer.observe(chatElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-busy'],
  });
  // Opening native details changes visibility without inserting any DOM nodes.
  chatElement.addEventListener('toggle', schedule, true);
  const themeObserver = new MutationObserver(() => images.forEach(control => control.refreshTheme()));
  for (const element of [document.documentElement, document.body]) {
    themeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
  window.addEventListener('witch-paintbox:preferences-changed', schedule, { signal });
  window.addEventListener('storage', schedule, { signal });
  schedule();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    layout.dispose();
    automatic.dispose();
    stopHistory();
    observer.disconnect();
    chatElement.removeEventListener('toggle', schedule, true);
    observedFrames.forEach(watch => watch.dispose());
    observedFrames.clear();
    themeObserver.disconnect();
    stopWatching();
    clearImages();
  };
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}
