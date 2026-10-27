import { generateConfiguredImage } from './image-provider.js';
import { loadImageSettings } from './image-settings.js';
import { imageChatContext } from './chat-host.js';
import { createImageGallery, type GalleryImage } from './image-gallery.js';
import { loadImageHistory, saveImageHistory, deleteImageHistory, historyWasDeleted, type ImageHistoryChange, type ImageHistoryEntry } from './image-history.js';
import type { MarkerEntry } from './image-marker-history.js';
import { currentPreferences } from './settings.js';
import { awaitSifangChatRefresh } from './sifang-chat.js';

export interface NativeImageView {
  state: 'idle' | 'queued' | 'generating';
  status: string;
  blob: Blob | null;
}

/** The native view is transient. History, gallery and requests keep the plugin's existing storage and queue. */
export function createSifangImageControl(entry: MarkerEntry, root: ShadowRoot, hooks: {
  current(): boolean;
  latest(): boolean;
  pending(): boolean;
  update(view: NativeImageView): void;
}) {
  const controller = new AbortController();
  let request: AbortController | null = null;
  let phase: NativeImageView['state'] = 'idle';
  let status = '正在读取图片历史…';
  let history: GalleryImage[] = [];
  let selectedId: string | null = null;
  let historyAvailable = false;
  let deletedBefore = 0;
  const deletedIds = new Set<string>();
  const saves = new Map<string, Promise<void>>();
  const historyKey = entry.historyKey;
  const gallery = createImageGallery(entry.marker.summary, controller.signal, {
    onSelect(id) { selectedId = id; show(); },
    async onDelete(id) {
      const index = history.findIndex(item => item.entry.id === id);
      if (index < 0) return;
      await saves.get(id)?.catch(() => {});
      if (historyKey) await deleteImageHistory(id);
      if (controller.signal.aborted) return;
      remove({ deletedIds: [id] });
    },
  });
  root.append(gallery.element);

  function show() {
    if (controller.signal.aborted) return;
    gallery.setImages(history, selectedId);
    hooks.update({ state: phase, status, blob: history.find(item => item.entry.id === selectedId)?.entry.blob ?? null });
  }
  function report(text: string) { status = text; show(); }
  function remove(change: ImageHistoryChange) {
    change.deletedIds?.forEach(id => deletedIds.add(id));
    deletedBefore = Math.max(deletedBefore, change.before ?? 0);
    const removed = history.filter(item => historyWasDeleted(item.entry, change));
    history = history.filter(item => !historyWasDeleted(item.entry, change));
    if (!history.some(item => item.entry.id === selectedId)) selectedId = history.at(-1)?.entry.id ?? null;
    if (removed.length && !request) status = history.length ? `剩余 ${history.length} 张图片` : '图片已清理，可重新生成。';
    show();
    removed.forEach(item => URL.revokeObjectURL(item.url));
  }

  const ready = (historyKey ? loadImageHistory(historyKey) : Promise.resolve([])).then(entries => {
    if (controller.signal.aborted) return;
    historyAvailable = true;
    history = entries.filter(item => item.createdAt >= deletedBefore && !deletedIds.has(item.id))
      .map(item => ({ entry: item, url: URL.createObjectURL(item.blob) }));
    selectedId = history.at(-1)?.entry.id ?? null;
    report(history.length ? `已恢复 ${history.length} 张图片 · 点击查看历史` : '');
  }).catch(error => report(error instanceof Error ? error.message : '图片历史读取失败。'));

  async function generate(autoSignal?: AbortSignal): Promise<void> {
    if (controller.signal.aborted || request || autoSignal?.aborted || !hooks.current()) return;
    const job = new AbortController();
    const cancel = () => job.abort();
    controller.signal.addEventListener('abort', cancel, { once: true });
    autoSignal?.addEventListener('abort', cancel, { once: true });
    request = job;
    phase = 'queued';
    report('正在加入队列…');
    try {
      const settings = loadImageSettings();
      await ready;
      await awaitSifangChatRefresh();
      job.signal.throwIfAborted();
      if (!hooks.current()) { job.abort(); job.signal.throwIfAborted(); }
      const result = await generateConfiguredImage(settings, entry.marker.prompt, job.signal, progress => {
        if (!hooks.current() || (progress.state === 'generating' && hooks.pending())) { job.abort(); return; }
        if (autoSignal && progress.state === 'generating' && (!currentPreferences().autoGenerateImages || !hooks.latest())) { job.abort(); return; }
        phase = progress.state;
        report(progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在绘制…');
      }, settings.positive);
      await awaitSifangChatRefresh();
      if (job.signal.aborted || controller.signal.aborted || !hooks.current()) return;
      const item: ImageHistoryEntry = {
        id: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`,
        ...result, markerKey: historyKey ?? entry.key, createdAt: Date.now(), scenePrompt: entry.marker.prompt,
        title: entry.marker.summary, sourceName: imageChatContext()?.name,
      };
      const save = historyKey ? saveImageHistory(item) : Promise.resolve();
      saves.set(item.id, save);
      history.push({ entry: item, url: URL.createObjectURL(item.blob) });
      selectedId = item.id;
      report('绘制完成，正在保存图片历史…');
      try {
        await save;
        report(historyKey ? `已保存 ${history.length} 张图片 · 点击查看历史` : '图片仅保留在当前页面，可下载保存。');
      } catch (error) {
        report(`图片已生成，但历史未保存：${error instanceof Error ? error.message : '浏览器存储不可用。'}`);
      } finally { saves.delete(item.id); }
    } catch (error) {
      report(job.signal.aborted ? '已取消本次等待，服务端任务可能仍在继续。' : error instanceof Error ? error.message : '生图未完成，请稍后重试。');
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      autoSignal?.removeEventListener('abort', cancel);
      request = null;
      phase = 'idle';
      show();
    }
  }

  return {
    generate,
    async generateAutomatically(signal: AbortSignal) {
      await ready;
      if (signal.aborted || !historyAvailable || history.length || request) return;
      await generate(signal);
    },
    cancel() { request?.abort(); },
    open() { if (history.length) gallery.open(); },
    removeHistory: remove,
    refresh: show,
    dispose() {
      controller.abort(); gallery.close(); gallery.element.remove();
      history.forEach(item => URL.revokeObjectURL(item.url)); history = [];
    },
  };
}
