import type { ImageInsertionResult } from './image-insertion.js';
import { captureEmbeddedWrite, readEmbeddedTurn } from './embedded-chat.js';
import { isSifangEnvironment } from './sifang-host.js';
import { assertSifangSnapshot, captureSifangAssistant, isSifangChatReady, readSifangAssistantMessages,
  readSifangFloors, replaceSifangAssistant, sifangImageChatContext, watchSifangChat } from './sifang-chat.js';
import type { PetFault } from './pet-events.js';

type ChatMessage = Record<string, unknown> & {
  mes: string;
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  swipe_id?: number;
  swipes?: string[];
};

interface ChatHost {
  chat: ChatMessage[];
  chatId?: string;
  characterId?: string | number;
  groupId?: string | number;
  chatMetadata: Record<string, unknown>;
  characters: Array<{ name: string; avatar: string; chat?: string }>;
  groups: Array<{ id: string | number; chat_id: string }>;
  getCurrentChatId?(): string | undefined;
  getRequestHeaders(): HeadersInit;
  messageFormatting(text: string, name: string, isSystem: boolean, isUser: boolean, id: number): string;
  eventTypes: Record<string, string>;
  eventSource: {
    on(event: string, callback: (...args: unknown[]) => void): void;
    makeFirst?(event: string, callback: (...args: unknown[]) => void): void;
    makeLast?(event: string, callback: (...args: unknown[]) => void): void;
    removeListener(event: string, callback: (...args: unknown[]) => void): void;
  };
}

interface NativeState {
  is_send_press?: boolean;
  isChatSaving?: boolean;
  isGenerating?: () => boolean;
}

export interface ChatSnapshot {
  readonly chatId: string;
  readonly messageId: number;
  readonly swipeId: number | null;
  readonly text: string;
}

export interface ImageDisplayChange extends Omit<ImageInsertionResult, 'warnings'> {
  previousText: string;
}

type ChatRenderListener = (messageId?: number, change?: ImageDisplayChange, event?: string) => void;

interface SnapshotState {
  chat: ChatMessage[];
  message: ChatMessage;
  length: number;
  characterId: ChatHost['characterId'];
  groupId: ChatHost['groupId'];
  swipes: string[] | undefined;
  swipeText: string | undefined;
  swipeCount: number;
  embedded: ReturnType<typeof captureEmbeddedWrite>;
}

class ChatHostError extends Error { readonly fault: PetFault = 'host'; }
const snapshots = new WeakMap<ChatSnapshot, SnapshotState>();
const renderListeners = new Set<ChatRenderListener>();
let saving = false;
let nativePromise: Promise<{ main: NativeState; group: { is_group_generating?: boolean } }> | undefined;

function host(): ChatHost {
  const root = globalThis as typeof globalThis & { SillyTavern?: { getContext(): unknown } };
  const value = root.SillyTavern?.getContext() as Partial<ChatHost> | undefined;
  if (!value || !Array.isArray(value.chat) || typeof value.getRequestHeaders !== 'function') {
    throw new ChatHostError('这个环境里没接通酒馆聊天接口。');
  }
  return value as ChatHost;
}

function chatId(context: ChatHost): string {
  const value = context.getCurrentChatId?.() ?? context.chatId;
  if (value === undefined || value === null || value === '') throw new ChatHostError('得先打开一个已经保存过的聊天才行。');
  return String(value);
}

async function nativeState() {
  // Import the already-loaded native modules to read their live generation flags.
  // These flags cover generation that started before this extension was opened.
  nativePromise ??= Promise.all([
    import(new URL('/script.js', location.href).href),
    import(new URL('/scripts/group-chats.js', location.href).href),
  ]).then(([main, group]) => ({ main: main as NativeState, group: group as { is_group_generating?: boolean } }))
    .catch(() => { nativePromise = undefined; throw new ChatHostError('没法确认酒馆现在是不是还在输出，稍后再试试。'); });
  return nativePromise;
}

function requireIdle(state: Awaited<ReturnType<typeof nativeState>>): void {
  if (typeof state.main.isGenerating !== 'function' && typeof state.main.is_send_press !== 'boolean') {
    throw new ChatHostError('你这版酒馆没提供生成状态接口，画匣不敢贸然改楼层。');
  }
  if (state.main.isGenerating?.() || state.main.is_send_press || state.group.is_group_generating) {
    throw new ChatHostError('等酒馆把这一楼写完，再点处理哦。');
  }
  if (state.main.isChatSaving || saving) throw new ChatHostError('酒馆正存着聊天呢，稍等一秒再点。');
  if (document.querySelector('#chat .edit_textarea, #chat .reasoning_edit_textarea')) {
    throw new ChatHostError('你现在还开着楼层编辑框呢，保存或取消编辑后再继续吧。');
  }
}

/** Automatic generation waits for the native reply and any floor edits to finish. */
export async function isChatReadyForImages(): Promise<boolean> {
  if (isSifangEnvironment()) return isSifangChatReady();
  try { requireIdle(await nativeState()); return true; } catch { return false; }
}

export function imageChatContext(): { scope: string; name: string; chatId: string; latestMessageId: number } | null {
  if (isSifangEnvironment()) return sifangImageChatContext();
  try {
    const context = host();
    const id = chatId(context);
    const group = context.groupId !== undefined && context.groupId !== null && context.groupId !== '';
    const character = context.characters[Number(context.characterId)];
    if (!group && !character) return null;
    return {
      scope: JSON.stringify(group ? ['group', String(context.groupId)] : ['character', character.avatar ?? context.characterId]),
      name: group ? '当前群聊' : character.name,
      chatId: id, latestMessageId: context.chat.length - 1,
    };
  } catch { return null; }
}

function latestAssistant(context: ChatHost): number {
  for (let id = context.chat.length - 1; id >= 0; id--) {
    const message = context.chat[id];
    if (message && !message.is_user && !message.is_system && typeof message.mes === 'string') return id;
  }
  throw new ChatHostError('聊到这儿还没有可以加配图的 AI 回复呢。');
}

function currentSwipe(message: ChatMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  const id = message.swipe_id ?? 0;
  if (!Number.isInteger(id) || id < 0 || id >= message.swipes.length || typeof message.swipes[id] !== 'string') {
    throw new ChatHostError('这一楼的分支切换状态不对劲，退出来重进一次聊天吧。');
  }
  return id;
}

function takeSnapshot(context: ChatHost, messageId: number): ChatSnapshot {
  const message = context.chat[messageId];
  const swipeId = currentSwipe(message);
  const snapshot: ChatSnapshot = Object.freeze({ chatId: chatId(context), messageId, swipeId, text: message.mes });
  snapshots.set(snapshot, {
    chat: context.chat, message, length: context.chat.length,
    characterId: context.characterId, groupId: context.groupId,
    swipes: message.swipes, swipeText: swipeId === null ? undefined : message.swipes?.[swipeId],
    swipeCount: message.swipes?.length ?? 0,
    embedded: captureEmbeddedWrite(messageId, message.mes),
  });
  return snapshot;
}

function sameTarget(snapshot: ChatSnapshot, expectedText: string): ChatHost | null {
  const saved = snapshots.get(snapshot);
  if (!saved) return null;
  try {
    const context = host();
    if (chatId(context) !== snapshot.chatId || context.chat !== saved.chat
      || context.characterId !== saved.characterId || context.groupId !== saved.groupId
      || context.chat.length !== saved.length || context.chat[snapshot.messageId] !== saved.message
      || latestAssistant(context) !== snapshot.messageId || saved.message.mes !== expectedText
      || currentSwipe(saved.message) !== snapshot.swipeId || saved.message.swipes !== saved.swipes
      || (saved.message.swipes?.length ?? 0) !== saved.swipeCount) return null;
    const expectedSwipe = expectedText === snapshot.text ? saved.swipeText : expectedText;
    if (snapshot.swipeId !== null && saved.message.swipes?.[snapshot.swipeId] !== expectedSwipe) return null;
    if (saved.embedded) saved.embedded.assertCurrent(expectedText);
    else if (captureEmbeddedWrite(snapshot.messageId, expectedText)) return null;
    return context;
  } catch { return null; }
}

function requireSnapshot(snapshot: ChatSnapshot): ChatHost {
  const context = sameTarget(snapshot, snapshot.text);
  if (!context) throw new ChatHostError('刚才切了聊天或者原楼层变了，为了防止写串，这次结果没写回去。');
  return context;
}

export async function captureLatestAssistant(): Promise<ChatSnapshot> {
  if (isSifangEnvironment()) return captureSifangAssistant();
  const state = await nativeState();
  requireIdle(state);
  const context = host();
  const id = latestAssistant(context);
  if (!context.chat[id].mes.trim()) throw new ChatHostError('最新一楼 AI 回复还是空的。');
  return takeSnapshot(context, id);
}

export async function assertChatSnapshot(snapshot: ChatSnapshot): Promise<void> {
  if (isSifangEnvironment()) { await assertSifangSnapshot(snapshot); return; }
  const state = await nativeState();
  requireIdle(state);
  requireSnapshot(snapshot);
}

function notifyRendered(messageId?: number, change?: ImageDisplayChange): void {
  for (const listener of renderListeners) {
    try { listener(messageId, change); } catch { /* A view error must not undo a saved message. */ }
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** The read endpoint returns a header followed by messages, including full swipe history. */
function matchesSavedChat(value: unknown, expected: ChatMessage[], metadata: Record<string, unknown>, snapshot: ChatSnapshot): boolean {
  if (!Array.isArray(value) || value.length !== expected.length + 1) return false;
  const storedMetadata = jsonRecord(jsonRecord(value[0])?.chat_metadata);
  if (!storedMetadata || (metadata.integrity !== undefined && storedMetadata.integrity !== metadata.integrity)) return false;
  // Compare narrative across the chat, but do not compare unloaded historical swipe slots.
  if (!expected.every((message, index) => {
    const stored = jsonRecord(value[index + 1]);
    return stored && stored.mes === message.mes && stored.name === message.name
      && Boolean(stored.is_user) === Boolean(message.is_user)
      && Boolean(stored.is_system) === Boolean(message.is_system);
  })) return false;
  const target = jsonRecord(value[snapshot.messageId + 1])!;
  return snapshot.swipeId === null
    ? !Array.isArray(target.swipes)
    : (target.swipe_id ?? 0) === snapshot.swipeId && Array.isArray(target.swipes)
      && target.swipes[snapshot.swipeId] === expected[snapshot.messageId].mes;
}

/** Commit only after the host confirms storage; updating image controls never rebuilds the floor. */
export async function replaceAssistantMessage(snapshot: ChatSnapshot, result: ImageInsertionResult, signal?: AbortSignal): Promise<ChatSnapshot> {
  const nextText = result.text;
  if (typeof nextText !== 'string' || !nextText.trim()) throw new ChatHostError('处理出来是空的，楼层原文一点没动。');
  if (isSifangEnvironment()) return replaceSifangAssistant(snapshot, nextText, signal);
  const change: ImageDisplayChange = {
    previousText: snapshot.text, text: nextText, added: result.added.map(marker => ({ ...marker })),
  };
  const state = await nativeState();
  signal?.throwIfAborted();
  requireIdle(state);
  const context = requireSnapshot(snapshot);
  const saved = snapshots.get(snapshot)!;
  if (nextText === snapshot.text) return snapshot;

  // Build a destination and full chat snapshot synchronously before the first await.
  const chat = structuredClone(context.chat);
  chat[snapshot.messageId].mes = nextText;
  if (snapshot.swipeId !== null) chat[snapshot.messageId].swipes![snapshot.swipeId] = nextText;
  const header = { user_name: 'unused', character_name: 'unused', chat_metadata: structuredClone(context.chatMetadata) };
  const group = context.groupId === undefined || context.groupId === null || context.groupId === ''
    ? undefined : context.groups.find(item => String(item.id) === String(context.groupId));
  const character = context.characters[Number(context.characterId)];
  if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '' && !group) {
    throw new ChatHostError('找不着当前群聊要存去哪儿。');
  }
  if (!group && (!character?.avatar || !character.chat)) throw new ChatHostError('找不着当前聊天要存去哪儿。');
  if (String(group ? group.chat_id : character.chat) !== snapshot.chatId) {
    throw new ChatHostError('刚才聊天保存路径变了，为了安全这次没往里写。');
  }
  const endpoint = group ? '/api/chats/group/save' : '/api/chats/save';
  const body = JSON.stringify(group
    ? { id: group.chat_id, chat: [header, ...chat], force: false }
    : { ch_name: character.name, avatar_url: character.avatar, file_name: character.chat, chat: [header, ...chat], force: false });
  const readEndpoint = group ? '/api/chats/group/get' : '/api/chats/get';
  const readBody = JSON.stringify(group ? { id: group.chat_id }
    : { ch_name: character.name, avatar_url: character.avatar, file_name: character.chat });
  const headers = context.getRequestHeaders();
  requireSnapshot(snapshot);
  signal?.throwIfAborted();
  saving = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let persisted = false;
  try {
    // The native saveChat helper swallows HTTP failures, so use its official endpoint
    // and integrity metadata directly, without its force-overwrite recovery flow.
    const response = await fetch(endpoint, {
      method: 'POST', headers, body, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new ChatHostError('保存聊天没过，不确定酒馆服务端存上没；看下连接或者重进聊天确认一眼吧。');
    const confirmation = jsonRecord(await response.json().catch(() => null));
    if (confirmation?.error || confirmation?.ok === false || confirmation?.success === false) {
      throw new ChatHostError('酒馆那边回了个保存失败，画匣没有乱改现在页面上的正文。');
    }
    // ST 1.13.5 uses { result: 'ok' } for individual chats; newer ST and TT use { ok: true }.
    if (confirmation?.ok !== true && confirmation?.result !== 'ok') {
      // Unknown replies need proof from the same saved chat; never assume HTTP 200
      // means saved or repeat the write.
      const readback = await fetch(readEndpoint, {
        method: 'POST', headers, body: readBody, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      });
      const stored: unknown = readback.ok ? await readback.json().catch(() => null) : null;
      if (!matchesSavedChat(stored, chat, header.chat_metadata, snapshot)) {
        throw new ChatHostError('保存回执看着不对，再读一遍也没确认存没存上；先重进一次聊天看一眼，先别急着再跑一遍 AI 处理。');
      }
    }
    persisted = true;
    let current: ChatHost;
    try { current = requireSnapshot(snapshot); }
    catch { throw new ChatHostError('配图其实存进原聊天了；只是页面刚才切了或楼层变了，退回去重开原聊天就能看到。'); }
    saved.message.mes = nextText;
    if (snapshot.swipeId !== null) saved.message.swipes![snapshot.swipeId] = nextText;
    try { await saved.embedded?.save(nextText); }
    catch {
      notifyRendered(snapshot.messageId, change);
      throw new ChatHostError('配图已经存进酒馆了，不过没收到前端历史同步的回信；看一眼这一轮正不正常，先别重复跑 AI。');
    }
    if (!sameTarget(snapshot, nextText)) {
      throw new ChatHostError('配图存进去了，不过你刚刚切走聊天或换了前端；退回原本那个聊天就能确认。');
    }
    // Capture the committed version before a view listener can change the active chat.
    const committed = takeSnapshot(current, snapshot.messageId);
    notifyRendered(snapshot.messageId, change);
    return committed;
  } catch (error) {
    if (error instanceof ChatHostError) throw error;
    throw new ChatHostError(persisted
      ? '其实已经存好了，只是这个页面刚才没同步上，重开一下原聊天看看。'
      : '没收到聊天保存确认，不确定服务端有没有落盘；画匣这边没改动你现在看到的正文。');
  } finally {
    clearTimeout(timer);
    saving = false;
  }
}

function historyIdentities(messages: ChatMessage[]): Map<number, string> {
  const counts = new Map<string, number>();
  const current = new Map<number, string>();
  messages.forEach((message, messageId) => {
    if (!message || message.is_user || message.is_system) return;
    const active = message.swipe_id ?? 0;
    const versions = Array.isArray(message.swipes) && message.swipes.length ? message.swipes.length : 1;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info : [];
    for (let version = 0; version < versions; version++) {
      // A floor's array index changes when earlier floors are deleted. Native
      // timestamps identify a reply version without writing IDs into the chat.
      const value = version === active ? message.send_date ?? info[version]?.send_date : info[version]?.send_date;
      const timestamp = value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString()
        : typeof value === 'number' && Number.isFinite(value) ? String(value)
          : typeof value === 'string' ? value.trim() : '';
      if (!timestamp) continue;
      const parsed = Date.parse(timestamp);
      const date = typeof value === 'number' ? value : Number.isFinite(parsed) ? parsed : timestamp;
      const id = JSON.stringify([date, message.name ?? '', typeof message.original_avatar === 'string' ? message.original_avatar : '']);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (version === active) current.set(messageId, id);
    }
  });
  // Imported replies can share a timestamp. Do not guess which history belongs
  // to them or fall back to a mutable floor/swipe index.
  return new Map([...current].filter(([, id]) => counts.get(id) === 1));
}

export function readAssistantMessages(): Array<{ scope: string; chatId: string; messageId: number; swipeId: number | null; historyId: string | null; turnId: string | null; text: string }> {
  if (isSifangEnvironment()) return readSifangAssistantMessages();
  const context = host();
  const id = chatId(context);
  const scope = context.groupId !== undefined && context.groupId !== null && context.groupId !== ''
    ? JSON.stringify(['group', String(context.groupId)])
    : JSON.stringify(['character', context.characters[Number(context.characterId)]?.avatar ?? context.characterId]);
  const identities = historyIdentities(context.chat);
  return context.chat.flatMap((message, messageId) => {
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return [];
    try {
      const embedded = readEmbeddedTurn(messageId);
      return [{ scope, chatId: id, messageId, swipeId: currentSwipe(message),
        historyId: embedded ? embedded.historyId : identities.get(messageId) ?? null,
        turnId: embedded?.turnId ?? null, text: embedded?.text ?? message.mes }];
    } catch {
      // A swipe being created may not have its text yet; other floors can still render.
      return [];
    }
  });
}

/** Uses the host sanitizer; rendering transient text never writes it into chat storage. */
export function formatChatText(text: string, messageId: number): string {
  if (isSifangEnvironment()) throw new ChatHostError('独立前端这边的正文交由原生配图接口自己渲染。');
  const context = host();
  const message = context.chat[messageId];
  if (!message || typeof context.messageFormatting !== 'function') throw new ChatHostError('这一楼现在渲染不出来。');
  // At message 0 the native formatter may expand macros into chat.mes. A replaced
  // marker differs from mes and avoids this; otherwise use the transient-message path.
  const formattingId = messageId === 0 && text === message.mes ? -1 : messageId;
  return context.messageFormatting(text, message.name ?? '', Boolean(message.is_system), Boolean(message.is_user), formattingId);
}

/** Pins a reply's identity while allowing its text to settle after variable updates. */
export interface ReplyTarget {
  readonly key: string;
  matches(snapshot: ChatSnapshot): boolean;
}

/** Read only the current final floor for stability polling; this is not a write-authorizing snapshot. */
export function readLatestAssistantReply(): ChatSnapshot | null {
  if (isSifangEnvironment()) {
    const context = sifangImageChatContext();
    const floor = readSifangFloors().at(-1);
    return context && floor?.role === 'assistant'
      ? { chatId: context.chatId, messageId: floor.floor, swipeId: Math.max(0, floor.version - 1), text: floor.raw } : null;
  }
  const context = host(), messageId = context.chat.length - 1, message = context.chat[messageId];
  return message && !message.is_user && !message.is_system && typeof message.mes === 'string'
    ? { chatId: chatId(context), messageId, swipeId: message.swipe_id ?? null, text: message.mes } : null;
}

export type ReplyActivity = { kind: 'reply'; target: ReplyTarget }
  | { kind: 'helper-start' | 'helper-end' | 'helper-progress'; id: string }
  | { kind: 'activity' | 'stopped' | 'reset' };

function replyTarget(messageId?: number): ReplyTarget | null {
  if (isSifangEnvironment()) {
    const context = sifangImageChatContext();
    const floor = readSifangFloors().at(-1);
    if (!context || !floor || floor.role !== 'assistant' || messageId !== undefined && floor.floor !== messageId) return null;
    return {
      key: JSON.stringify([context.chatId, floor.node]),
      matches: snapshot => snapshot.chatId === context.chatId && snapshot.messageId === floor.floor
        && sifangImageChatContext()?.chatId === context.chatId && readSifangFloors().at(-1)?.node === floor.node,
    };
  }
  const context = host();
  const id = messageId ?? context.chat.length - 1;
  const message = context.chat[id];
  if (id !== context.chat.length - 1 || !message || message.is_user || message.is_system || !message.mes?.trim()) return null;
  const chat = context.chat, chatIdentity = chatId(context), swipe = message.swipe_id ?? 0;
  const { characterId, groupId } = context;
  return {
    key: JSON.stringify([chatIdentity, characterId, groupId, id, swipe]),
    matches(snapshot) {
      const current = host();
      return snapshot.chatId === chatIdentity && snapshot.messageId === id && (snapshot.swipeId ?? 0) === swipe
        && chatId(current) === chatIdentity && current.chat === chat && current.chat[id] === message
        && current.characterId === characterId && current.groupId === groupId && current.chat.length - 1 === id
        && (message.swipe_id ?? 0) === swipe;
    },
  };
}

/** Follow completed native replies and Tavern Helper jobs; never arm from a generation start alone. */
export function watchReplyGeneration(callback: (event: ReplyActivity) => void): () => void {
  if (isSifangEnvironment()) {
    let previous = '';
    return watchSifangChat((messageId, event) => {
      const latest = readSifangFloors().at(-1);
      const fingerprint = JSON.stringify([sifangImageChatContext()?.chatId, latest?.node, latest?.version, latest?.raw]);
      // Snapshot reads refresh this cache too; unchanged reads are not new floor activity.
      if (event === 'MESSAGE_UPDATED' && fingerprint === previous) return;
      previous = fingerprint;
      if (event === 'CHAT_CHANGED' || event === 'MESSAGE_DELETED') callback({ kind: 'reset' });
      else if (event === 'GENERATION_ENDED') {
        const target = replyTarget(messageId);
        if (target) callback({ kind: 'reply', target });
      } else callback({ kind: 'activity' });
    });
  }
  const context = host();
  const source = context.eventSource;
  if (!source?.on || !source.removeListener || !context.eventTypes?.MESSAGE_RECEIVED || !context.eventTypes.GENERATION_STARTED) {
    throw new ChatHostError('当前的酒馆环境没开放回复完成的通知事件。');
  }
  const subscriptions: Array<{ event: string; handler: (...args: unknown[]) => void; last: boolean }> = [];
  const reorder = () => {
    for (const { event, handler, last } of subscriptions) if (last) source.makeLast?.(event, handler);
  };
  function listen(event: string | undefined, action: (...args: unknown[]) => void, last = true) {
    if (!event) return;
    const handler = (...args: unknown[]) => { try { action(...args); } catch { /* Never interrupt host generation. */ } };
    const ordered = last ? source.makeLast : source.makeFirst;
    (ordered ?? source.on).call(source, event, handler);
    subscriptions.push({ event, handler, last });
  }
  let expecting = false;
  const replyTypes = new Set(['normal', 'swipe', 'regenerate', 'continue', 'append', 'appendFinal']);
  listen(context.eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
    if (dryRun) return;
    reorder(); // Include card scripts that subscribed after this extension loaded.
    if (type === 'quiet') { callback({ kind: 'activity' }); return; }
    expecting = typeof type === 'string' && replyTypes.has(type);
    callback({ kind: 'reset' });
  }, false);
  listen(context.eventTypes.MESSAGE_RECEIVED, (messageId, type) => {
    const eligible = expecting && (type === undefined || typeof type === 'string' && replyTypes.has(type));
    if (eligible) {
      expecting = false;
      const target = typeof messageId === 'number' ? replyTarget(messageId) : null;
      if (target) { callback({ kind: 'reply', target }); return; }
    }
    callback({ kind: 'activity' });
  });
  listen(context.eventTypes.GENERATION_STOPPED, id => {
    // Tavern Helper uses this same native event, with a string generation ID.
    if (typeof id === 'string' && id) callback({ kind: 'helper-end', id });
    else { expecting = false; callback({ kind: 'stopped' }); }
  });
  for (const name of ['CHAT_CHANGED', 'CHAT_LOADED']) {
    listen(context.eventTypes[name], () => { expecting = false; callback({ kind: 'reset' }); }, false);
  }
  // Regeneration can delete the old reply after GENERATION_STARTED. Cancel its
  // pending work without forgetting the replacement reply we are waiting for.
  listen(context.eventTypes.MESSAGE_DELETED, () => callback({ kind: 'reset' }), false);
  listen(context.eventTypes.MESSAGE_SENT, () => callback({ kind: 'reset' }), false);
  for (const name of ['GENERATION_ENDED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED']) {
    listen(context.eventTypes[name], () => callback({ kind: 'activity' }));
  }
  // Root extensions share Tavern Helper's emitter. Its eventMakeLast API is iframe-only;
  // eventSource.makeLast is the native equivalent, without wrapping generate/fetch/XHR.
  const helperStart = (id: unknown) => {
    if (typeof id === 'string' && id) { reorder(); callback({ kind: 'helper-start', id }); }
  };
  listen('js_generation_requested', helperStart, false);
  listen('js_generation_started', helperStart, false);
  listen('js_generation_ended', (_text, id) => { if (typeof id === 'string' && id) callback({ kind: 'helper-end', id }); });
  listen('js_stream_token_received_fully', (_text, id) => { if (typeof id === 'string' && id) callback({ kind: 'helper-progress', id }); }, false);
  return () => { for (const { event, handler } of subscriptions) source.removeListener(event, handler); };
}

export function watchChatRendering(callback: ChatRenderListener): () => void {
  if (isSifangEnvironment()) return watchSifangChat((messageId, event) => callback(messageId, undefined, event));
  const context = host();
  renderListeners.add(callback);
  const subscriptions: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
  for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED',
    'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED',
    'GENERATION_ENDED', 'GENERATION_STOPPED']) {
    const event = context.eventTypes?.[name];
    if (!event) continue;
    const handler = (...args: unknown[]) => {
      try { callback(typeof args[0] === 'number' ? args[0] : undefined, undefined, name); } catch { /* Do not interrupt host rendering. */ }
    };
    context.eventSource.on(event, handler);
    subscriptions.push({ event, handler });
  }
  return () => {
    renderListeners.delete(callback);
    for (const { event, handler } of subscriptions) context.eventSource.removeListener(event, handler);
  };
}
