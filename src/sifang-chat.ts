import type { ChatSnapshot } from './chat-host.js';
import { requireSifangHost, type SifangFloor, type SifangSave } from './sifang-host.js';

type Listener = (messageId?: number, event?: string) => void;
const listeners = new Set<Listener>();
const snapshots = new WeakMap<ChatSnapshot, { floor: SifangFloor; latestNode: string; length: number }>();
let floors: SifangFloor[] = [];
let save: SifangSave | null = null;
let identity: { scope: string; name: string } | null = null;
let valid = false;
let saving = false;
let streaming = false;
let activity = 0;
const invalidNodes = new Set<string>();
const invalidFloors = new Set<number>();
let revision = 0;
let lifecycle: AbortSignal | undefined;
let initializing: Promise<void> | undefined;
let currentRefresh: { promise: Promise<void>; settled: boolean } | undefined;

function chatId(value: SifangSave): string { return JSON.stringify(['sifang', value.id, value.volume]); }
function sameSave(a: SifangSave, b: SifangSave): boolean { return a.id === b.id && a.volume === b.volume; }
function belongs(floor: SifangFloor, value: SifangSave): boolean { return floor.saveId === value.id && floor.volume === value.volume; }

/** Only character metadata comes from the compatibility context; body text is always native. */
function characterIdentity(): { scope: string; name: string } | null {
  const context = (globalThis as typeof globalThis & { SillyTavern?: { getContext(): {
    characterId?: string | number; name2?: string; characters?: Array<{ avatar?: string; name?: string }>;
  } } }).SillyTavern?.getContext();
  const character = context?.characters?.[Number(context.characterId)];
  const name = character?.name || context?.name2;
  const key = character?.avatar || name;
  return key ? { scope: JSON.stringify(['character', key]), name: name || key } : null;
}

function checkFloor(floor: SifangFloor): void {
  if (!Number.isInteger(floor.floor) || floor.floor < 0 || !floor.node || !floor.saveId
    || typeof floor.raw !== 'string' || typeof floor.busy !== 'boolean') {
    throw new Error('独立前端的楼层接口版本和画匣对不上，升级一下独立前端吧。');
  }
}
function requireIdle(floor: SifangFloor | null): void {
  if (saving || floor?.busy) throw new Error('等这楼回复完、存稳当了再来点吧。');
}
function emit(messageId?: number, event?: string): void {
  for (const listener of listeners) {
    try { listener(messageId, event); } catch { /* A view cannot undo a persisted floor. */ }
  }
}

function refresh(event: string, messageId?: number): Promise<void> {
  const pending = { promise: readFloors(event, messageId), settled: false };
  currentRefresh = pending;
  void pending.promise.then(() => { pending.settled = true; }, () => { pending.settled = true; });
  return pending.promise;
}

async function readFloors(event: string, messageId?: number): Promise<void> {
  const host = requireSifangHost();
  const ticket = ++revision;
  const seenActivity = activity;
  const before = await host.game.save();
  if (lifecycle?.aborted || ticket !== revision) return;
  if (!before?.id) {
    valid = false; floors = []; save = null; identity = null;
    emit(undefined, 'CHAT_CHANGED');
    return;
  }
  if (save && !sameSave(save, before)) {
    valid = false;
    emit(undefined, 'CHAT_CHANGED');
  }
  const line = await host.game.floors();
  const loaded = await Promise.all(line.map(item => host.game.floor(item.floor)));
  const after = await host.game.save();
  if (lifecycle?.aborted || ticket !== revision) return;
  if (!after || !sameSave(before, after)) {
    valid = false;
    emit(undefined, 'CHAT_CHANGED');
    throw new Error('刚才换了存档，正等着当前正文同步过来呢。');
  }
  const next = loaded.filter((floor): floor is SifangFloor => floor !== null);
  next.forEach(checkFloor);
  if (next.length !== line.length || next.some((floor, index) => !belongs(floor, before) || floor.node !== line[index].node)) {
    throw new Error('楼层刚变过，正等着当前正文同步过来呢。');
  }
  const switched = !save || !sameSave(save, after);
  floors = next.sort((a, b) => a.floor - b.floor);
  save = after;
  identity = characterIdentity();
  valid = true;
  streaming = activity !== seenActivity || next.some(floor => floor.busy);
  invalidNodes.clear(); invalidFloors.clear();
  emit(messageId, switched ? 'CHAT_CHANGED' : event);
}

/** Subscribe before the first read, so changes during initialization invalidate its snapshot. */
export async function initializeSifangChat(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (lifecycle === signal && initializing) return initializing;
  const host = requireSifangHost();
  lifecycle = signal;
  const events: Record<string, string> = {
    floor: 'GENERATION_ENDED', swipe: 'MESSAGE_SWIPED', edit: 'MESSAGE_UPDATED',
    remove: 'MESSAGE_DELETED', save: 'CHAT_CHANGED',
  };
  const unsubs = Object.entries(events).map(([native, event]) => host.on(native, payload => {
    if (signal.aborted) return;
    ++activity;
    const data = payload as { floor?: unknown; node?: unknown; removed?: unknown; saveId?: unknown; volume?: unknown } | null;
    const messageId = data?.floor;
    const changedSave = save && (data?.saveId && data.saveId !== save.id
      || data && 'volume' in data && data.volume !== save.volume);
    if (native === 'save' || changedSave) {
      valid = false;
      emit(undefined, 'CHAT_CHANGED');
    } else if (native === 'edit' || native === 'swipe' || native === 'remove') {
      // Only the changed floor is unavailable during its read. Other floors'
      // queued images keep their valid identity and are not cancelled.
      if (typeof messageId === 'number') invalidFloors.add(messageId);
      if (typeof data?.node === 'string') invalidNodes.add(data.node);
      if (Array.isArray(data?.removed)) data.removed.forEach(node => { if (typeof node === 'string') invalidNodes.add(node); });
    }
    void refresh(event, typeof messageId === 'number' ? messageId : undefined)
      .catch(error => { if (!signal.aborted) void host.ui.toast(error instanceof Error ? error.message : '正文没同步过来。', 'fail').catch(() => {}); });
  }));
  unsubs.push(host.on('stream', () => { if (!signal.aborted) { streaming = true; ++activity; } }));
  signal.addEventListener('abort', () => {
    unsubs.forEach(stop => stop());
    if (lifecycle !== signal) return;
    ++revision; valid = false; streaming = false; floors = []; save = null; identity = null; initializing = undefined;
    currentRefresh = undefined;
    invalidNodes.clear(); invalidFloors.clear();
  }, { once: true });
  initializing = refresh('CHAT_CHANGED').catch(error => {
    // Settings can open before a game has been bound. Keep subscriptions alive
    // so the first native save/floor event can populate the empty cache.
    if (error instanceof Error && error.message.includes('no session bound')) return;
    throw error;
  });
  return initializing;
}

export function readSifangFloors(): readonly SifangFloor[] {
  return valid ? floors.filter(floor => !invalidNodes.has(floor.node) && !invalidFloors.has(floor.floor)) : [];
}

/** An edited floor can be temporarily unreadable while its unchanged markers are being reloaded. */
export function isSifangFloorPending(saveId: string, node: string): boolean {
  return Boolean(valid && save?.id === saveId && currentRefresh && !currentRefresh.settled
    && floors.some(floor => floor.node === node && (invalidNodes.has(node) || invalidFloors.has(floor.floor))));
}

/** Follow replacements of the pending read; callers then check the final marker identity normally. */
export async function awaitSifangChatRefresh(): Promise<void> {
  if (currentRefresh?.settled) return;
  while (currentRefresh) {
    const pending = currentRefresh;
    try { await pending.promise; }
    catch (error) { if (currentRefresh === pending) throw error; }
    if (currentRefresh === pending) return;
  }
}
export function sifangImageChatContext(): { scope: string; name: string; chatId: string; latestMessageId: number } | null {
  return valid && save && identity
    ? { ...identity, chatId: chatId(save), latestMessageId: floors.at(-1)?.floor ?? -1 } : null;
}
export function readSifangAssistantMessages(): Array<{
  scope: string; chatId: string; messageId: number; swipeId: number | null; historyId: string | null; turnId: string | null; text: string;
}> {
  const context = sifangImageChatContext();
  if (!context) return [];
  return readSifangFloors().filter(floor => floor.role === 'assistant').map(floor => ({
    scope: context.scope, chatId: context.chatId, messageId: floor.floor,
    swipeId: Math.max(0, floor.version - 1), historyId: floor.node, turnId: floor.node, text: floor.raw,
  }));
}
export function watchSifangChat(callback: Listener): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function snapshotFor(floor: SifangFloor, latestNode = floors.at(-1)?.node ?? floor.node, length = floors.length): ChatSnapshot {
  const snapshot: ChatSnapshot = Object.freeze({
    chatId: chatId({ id: floor.saveId, volume: floor.volume, name: '' }), messageId: floor.floor,
    swipeId: Math.max(0, floor.version - 1), text: floor.raw,
  });
  snapshots.set(snapshot, { floor, latestNode, length });
  return snapshot;
}

export async function isSifangChatReady(): Promise<boolean> {
  try {
    const ticket = activity;
    const latest = await requireSifangHost().game.floor();
    if (ticket !== activity) return false;
    if (latest) checkFloor(latest);
    requireIdle(latest);
    if (!latest?.busy) streaming = false;
    return Boolean(valid && !streaming && save && latest?.role === 'assistant' && belongs(latest, save)
      && !invalidNodes.has(latest.node) && !invalidFloors.has(latest.floor));
  } catch { return false; }
}

export async function captureSifangAssistant(): Promise<ChatSnapshot> {
  await refresh('MESSAGE_UPDATED');
  const host = requireSifangHost();
  const latest = await host.game.floor();
  if (latest) checkFloor(latest);
  requireIdle(latest);
  if (!latest || !save || !belongs(latest, save)) throw new Error('聊到这儿还没有可以加配图的 AI 回复呢。');
  if (latest.role !== 'assistant') throw new Error('最新一楼是你自己发的话，等 AI 写完回复再来吧。');
  const floor = readSifangFloors().find(item => item.node === latest.node && item.floor === latest.floor && item.raw === latest.raw);
  if (!floor) throw new Error('最新一楼刚刚变过了，稍微等一下再试。');
  requireIdle(floor);
  if (!floor.raw.trim()) throw new Error('最新一楼 AI 回复还是空的。');
  return snapshotFor(floor, latest.node);
}

export async function assertSifangSnapshot(snapshot: ChatSnapshot): Promise<SifangFloor> {
  const state = snapshots.get(snapshot);
  if (!state) throw new Error('刚才切了聊天或者原楼层变了，为了防止写串，这次没写回去。');
  const saved = state.floor;
  const host = requireSifangHost();
  const [current, line, active, latest] = await Promise.all([
    host.game.floor(saved.floor), host.game.floors(), host.game.save(), host.game.floor(),
  ]);
  const lastAssistant = [...line].reverse().find(item => item.role === 'assistant');
  if (current) checkFloor(current);
  if (latest) checkFloor(latest);
  requireIdle(latest);
  requireIdle(current);
  if (!active || !current || !belongs(saved, active) || !belongs(current, active) || !latest || !belongs(latest, active)
    || current.node !== saved.node || current.raw !== snapshot.text || lastAssistant?.node !== saved.node
    || latest.role !== 'assistant' || latest.node !== state.latestNode || line.length !== state.length) {
    throw new Error('刚才切了聊天或者原楼层变了，为了防止写串，这次没写回去。');
  }
  return saved;
}

export async function replaceSifangAssistant(snapshot: ChatSnapshot, text: string, signal?: AbortSignal): Promise<ChatSnapshot> {
  const saved = await assertSifangSnapshot(snapshot);
  signal?.throwIfAborted();
  if (text === snapshot.text) return snapshot;
  saving = true;
  let committed: SifangFloor;
  try {
    committed = await requireSifangHost().game.replaceText({
      saveId: saved.saveId, node: saved.node, volume: saved.volume, expectedRaw: snapshot.text, raw: text,
    });
    checkFloor(committed);
    if (committed.node !== saved.node || committed.saveId !== saved.saveId || committed.volume !== saved.volume || committed.raw !== text) {
      throw new Error('独立前端没回原本那一楼的保存确认，重开一下那楼看一眼吧。');
    }
  } finally { saving = false; }
  await refresh('MESSAGE_UPDATED', saved.floor);
  return snapshotFor(committed);
}
