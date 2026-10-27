import { imageChatContext, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { loadModelSettings } from './model-settings.js';
import { markerEntries, type MarkerEntry, type AssistantImageMessage } from './image-marker-history.js';
import { automaticImages } from './automatic-images.js';
import { onImageHistoryChanged } from './image-history.js';
import { createSifangImageControl, type NativeImageView } from './sifang-image-control.js';
import { sifangHost, type SifangFloor } from './sifang-host.js';
import { readSifangFloors, isSifangFloorPending } from './sifang-chat.js';

interface NativeControl {
  id: string;
  entry: MarkerEntry;
  message: AssistantImageMessage;
  floor: SifangFloor;
  registered: boolean;
  view?: NativeImageView;
  lastBlob?: Blob | null;
  updating: boolean;
  revision: number;
  control: ReturnType<typeof createSifangImageControl>;
}

/** Render through the host's real paragraph blocks, while keeping the existing plugin image lifecycle. */
export function bindSifangImages(root: ShadowRoot, signal: AbortSignal): void {
  const host = sifangHost;
  if (!host || signal.aborted) return;
  const controls = new Map<string, NativeControl>();
  const registered = new Map<string, { floor: SifangFloor; signature: string }>();
  let version = 0;
  let rendering = false;
  let dirty = false;
  let errorText = '';

  const report = (error: unknown) => {
    if (signal.aborted) return;
    const text = error instanceof Error ? error.message : '配图显示接口未能完成操作。';
    if (text === errorText) return;
    errorText = text;
    void host.ui.toast(text, 'fail').catch(() => {});
  };
  function isCurrent(item: NativeControl): boolean {
    if (signal.aborted || controls.get(item.entry.key) !== item || !loadModelSettings().parseImageMarkers) return false;
    if (isSifangFloorPending(item.floor.saveId, item.floor.node)) return true;
    const message = readAssistantMessages().find(message => message.chatId === item.message.chatId
      && message.historyId === item.message.historyId && message.messageId === item.message.messageId);
    return Boolean(message && markerEntries(message).some(entry => entry.key === item.entry.key));
  }
  const automatic = automaticImages({
    mounted: ({ entry }) => { const item = controls.get(entry.key); return Boolean(item && item.registered && !isSifangFloorPending(item.floor.saveId, item.floor.node) && isCurrent(item)); },
    async generate({ entry }, signal) { await controls.get(entry.key)?.control.generateAutomatically(signal); },
  });

  async function update(item: NativeControl): Promise<void> {
    if (isSifangFloorPending(item.floor.saveId, item.floor.node) || item.updating || !item.registered || !item.view || signal.aborted) return;
    item.updating = true;
    try {
      let sent = -1;
      while (!signal.aborted && item.registered && isCurrent(item) && item.view && sent !== item.revision) {
        sent = item.revision;
        const view = item.view;
        const sendBlob = view.blob !== item.lastBlob;
        await host!.ui.imageMarker({ saveId: item.floor.saveId, node: item.floor.node, id: item.id,
          state: view.state, status: view.status, ...(sendBlob ? { blob: view.blob } : {}) });
        if (sendBlob) item.lastBlob = view.blob;
      }
    } catch (error) { report(error); }
    finally { item.updating = false; }
  }

  async function idFor(key: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return `wp-${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  async function render(): Promise<void> {
    if (rendering || signal.aborted) return;
    rendering = true;
    try {
      while (dirty && !signal.aborted) {
        dirty = false;
        const ticket = version;
        const enabled = loadModelSettings().parseImageMarkers;
        const messages = enabled ? readAssistantMessages() : [];
        const floors = readSifangFloors();
        const candidates = messages.flatMap(message => markerEntries(message).map(entry => ({ message, entry })));
        const wanted = new Set(candidates.map(item => item.entry.key));
        for (const [key, item] of controls) {
          if (wanted.has(key)) continue;
          item.registered = false; item.control.dispose(); controls.delete(key);
        }
        const groups = new Map<string, { floor: SifangFloor; items: NativeControl[] }>();
        for (const { message, entry } of candidates) {
          const floor = floors.find(floor => floor.floor === message.messageId && floor.raw === message.text);
          if (!floor) continue;
          let item = controls.get(entry.key);
          if (!item) {
            const id = await idFor(entry.key);
            if (signal.aborted || ticket !== version) break;
            const created = { id, entry, message, floor, registered: false, updating: false, revision: 0 } as NativeControl;
            created.control = createSifangImageControl(entry, root, {
              current: () => isCurrent(created),
              pending: () => isSifangFloorPending(created.floor.saveId, created.floor.node),
              latest: () => imageChatContext()?.latestMessageId === created.message.messageId,
              update(view) { created.view = view; ++created.revision; void update(created); },
            });
            controls.set(entry.key, created);
            item = created;
          }
          item.entry = entry; item.message = message; item.floor = floor;
          const groupKey = JSON.stringify([floor.saveId, floor.node]);
          const group = groups.get(groupKey) ?? { floor, items: [] };
          group.items.push(item); groups.set(groupKey, group);
        }
        if (signal.aborted) return;
        if (ticket !== version) { dirty = true; continue; }
        for (const [key, previous] of registered) {
          if (groups.has(key)) continue;
          const floor = floors.find(item => item.saveId === previous.floor.saveId && item.node === previous.floor.node) ?? previous.floor;
          // An old save may already be closed; the host also releases its transient registrations on switching.
          await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
          registered.delete(key);
        }
        for (const [key, { floor, items }] of groups) {
          const markers = items.map(item => ({ id: item.id, start: item.entry.marker.start, end: item.entry.marker.end, summary: item.entry.marker.summary }));
          const signature = JSON.stringify([floor.raw, markers]);
          if (registered.get(key)?.signature !== signature) {
            items.forEach(item => { item.registered = false; });
            await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers });
            if (signal.aborted) {
              await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
              return;
            }
            registered.set(key, { floor, signature });
            items.forEach(item => { item.lastBlob = undefined; });
          }
          if (signal.aborted || ticket !== version) { dirty = true; break; }
          items.forEach(item => { item.registered = true; void update(item); });
        }
        if (ticket === version && !signal.aborted) {
          automatic.update(candidates, enabled);
          errorText = '';
        }
      }
    } catch (error) { report(error); }
    finally { rendering = false; if (dirty && !signal.aborted) void render(); }
  }
  function schedule() { ++version; dirty = true; void render(); }

  const offImage = host.on('image-marker', value => {
    const event = value as { action?: string; saveId?: string; node?: string; marker?: { id?: string; start?: number; end?: number }; raw?: string } | null;
    if (!event || signal.aborted) return;
    const item = [...controls.values()].find(item => item.id === event.marker?.id && item.floor.saveId === event.saveId && item.floor.node === event.node);
    if (!item || !isCurrent(item) || event.raw !== item.message.text
      || item.entry.marker.start !== event.marker?.start || item.entry.marker.end !== event.marker?.end) return;
    if (event.action === 'generate') void item.control.generate();
    else if (event.action === 'open') item.control.open();
    else if (event.action === 'cancel') item.control.cancel();
  });
  const offChat = watchChatRendering((messageId, _change, event) => {
    if (['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED'].includes(event ?? '')) {
      for (const group of registered.values()) {
        if (event === 'CHAT_CHANGED' || messageId === undefined || group.floor.floor === messageId) group.signature = '';
      }
    }
    if (event === 'GENERATION_ENDED' || event === 'GENERATION_STOPPED') automatic.settled();
    schedule();
  });
  const offHistory = onImageHistoryChanged(change => controls.forEach(item => item.control.removeHistory(change)));
  window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
  window.addEventListener('witch-paintbox:preferences-changed', schedule, { signal });
  window.addEventListener('storage', schedule, { signal });
  signal.addEventListener('abort', () => {
    ++version; offImage(); offChat(); offHistory(); automatic.dispose();
    for (const item of controls.values()) { item.registered = false; item.control.dispose(); }
    controls.clear();
    for (const { floor } of registered.values()) {
      void host.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
    }
    registered.clear();
  }, { once: true });
  schedule();
}
