import { captureEmbeddedWrite, readEmbeddedTurn } from './embedded-chat.js';
class ChatHostError extends Error {
}
const snapshots = new WeakMap();
const renderListeners = new Set();
let saving = false;
let nativePromise;
function host() {
    const root = globalThis;
    const value = root.SillyTavern?.getContext();
    if (!value || !Array.isArray(value.chat) || typeof value.getRequestHeaders !== 'function') {
        throw new ChatHostError('当前环境没有提供酒馆聊天接口。');
    }
    return value;
}
function chatId(context) {
    const value = context.getCurrentChatId?.() ?? context.chatId;
    if (value === undefined || value === null || value === '')
        throw new ChatHostError('请先打开一个已保存的聊天。');
    return String(value);
}
async function nativeState() {
    // Import the already-loaded native modules to read their live generation flags.
    // These flags cover generation that started before this extension was opened.
    nativePromise ??= Promise.all([
        import(new URL('/script.js', location.href).href),
        import(new URL('/scripts/group-chats.js', location.href).href),
    ]).then(([main, group]) => ({ main: main, group: group }))
        .catch(() => { nativePromise = undefined; throw new ChatHostError('无法核对酒馆生成状态，请稍后重试。'); });
    return nativePromise;
}
function requireIdle(state) {
    if (typeof state.main.isGenerating !== 'function' && typeof state.main.is_send_press !== 'boolean') {
        throw new ChatHostError('当前酒馆版本未提供生成状态，暂时不能安全处理楼层。');
    }
    if (state.main.isGenerating?.() || state.main.is_send_press || state.group.is_group_generating) {
        throw new ChatHostError('请等酒馆完成当前回复后再处理。');
    }
    if (state.main.isChatSaving || saving)
        throw new ChatHostError('酒馆正在保存聊天，请稍后再试。');
    if (document.querySelector('#chat .edit_textarea, #chat .reasoning_edit_textarea')) {
        throw new ChatHostError('请先完成或取消正在进行的楼层编辑。');
    }
}
function latestAssistant(context) {
    for (let id = context.chat.length - 1; id >= 0; id--) {
        const message = context.chat[id];
        if (message && !message.is_user && !message.is_system && typeof message.mes === 'string')
            return id;
    }
    throw new ChatHostError('当前聊天还没有可处理的 AI 回复。');
}
function currentSwipe(message) {
    if (!Array.isArray(message.swipes))
        return null;
    const id = message.swipe_id ?? 0;
    if (!Number.isInteger(id) || id < 0 || id >= message.swipes.length || typeof message.swipes[id] !== 'string') {
        throw new ChatHostError('当前楼层的 swipe 状态无效，请重新打开聊天。');
    }
    return id;
}
function takeSnapshot(context, messageId) {
    const message = context.chat[messageId];
    const swipeId = currentSwipe(message);
    const snapshot = Object.freeze({ chatId: chatId(context), messageId, swipeId, text: message.mes });
    snapshots.set(snapshot, {
        chat: context.chat, message, length: context.chat.length,
        characterId: context.characterId, groupId: context.groupId,
        swipes: message.swipes, swipeText: swipeId === null ? undefined : message.swipes?.[swipeId],
        swipeCount: message.swipes?.length ?? 0,
        embedded: captureEmbeddedWrite(messageId, message.mes),
    });
    return snapshot;
}
function sameTarget(snapshot, expectedText) {
    const saved = snapshots.get(snapshot);
    if (!saved)
        return null;
    try {
        const context = host();
        if (chatId(context) !== snapshot.chatId || context.chat !== saved.chat
            || context.characterId !== saved.characterId || context.groupId !== saved.groupId
            || context.chat.length !== saved.length || context.chat[snapshot.messageId] !== saved.message
            || latestAssistant(context) !== snapshot.messageId || saved.message.mes !== expectedText
            || currentSwipe(saved.message) !== snapshot.swipeId || saved.message.swipes !== saved.swipes
            || (saved.message.swipes?.length ?? 0) !== saved.swipeCount)
            return null;
        const expectedSwipe = expectedText === snapshot.text ? saved.swipeText : expectedText;
        if (snapshot.swipeId !== null && saved.message.swipes?.[snapshot.swipeId] !== expectedSwipe)
            return null;
        if (saved.embedded)
            saved.embedded.assertCurrent(expectedText);
        else if (captureEmbeddedWrite(snapshot.messageId, expectedText))
            return null;
        return context;
    }
    catch {
        return null;
    }
}
function requireSnapshot(snapshot) {
    const context = sameTarget(snapshot, snapshot.text);
    if (!context)
        throw new ChatHostError('聊天或原回复已发生变化，本次结果没有写回。');
    return context;
}
export async function captureLatestAssistant() {
    const state = await nativeState();
    requireIdle(state);
    const context = host();
    const id = latestAssistant(context);
    if (!context.chat[id].mes.trim())
        throw new ChatHostError('最新 AI 回复为空。');
    return takeSnapshot(context, id);
}
export async function assertChatSnapshot(snapshot) {
    const state = await nativeState();
    requireIdle(state);
    requireSnapshot(snapshot);
}
function notifyRendered(messageId, change) {
    for (const listener of renderListeners) {
        try {
            listener(messageId, change);
        }
        catch { /* A view error must not undo a saved message. */ }
    }
}
/** Commit only after the host confirms storage; updating image controls never rebuilds the floor. */
export async function replaceAssistantMessage(snapshot, result, signal) {
    const nextText = result.text;
    if (typeof nextText !== 'string' || !nextText.trim())
        throw new ChatHostError('处理结果为空，原回复已保留。');
    const change = {
        previousText: snapshot.text, text: nextText, added: result.added.map(marker => ({ ...marker })),
    };
    const state = await nativeState();
    signal?.throwIfAborted();
    requireIdle(state);
    const context = requireSnapshot(snapshot);
    const saved = snapshots.get(snapshot);
    if (nextText === snapshot.text)
        return snapshot;
    // Build a destination and full chat snapshot synchronously before the first await.
    const chat = structuredClone(context.chat);
    chat[snapshot.messageId].mes = nextText;
    if (snapshot.swipeId !== null)
        chat[snapshot.messageId].swipes[snapshot.swipeId] = nextText;
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: structuredClone(context.chatMetadata) };
    const group = context.groupId === undefined || context.groupId === null || context.groupId === ''
        ? undefined : context.groups.find(item => String(item.id) === String(context.groupId));
    const character = context.characters[Number(context.characterId)];
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '' && !group) {
        throw new ChatHostError('无法确认当前群聊的保存位置。');
    }
    if (!group && (!character?.avatar || !character.chat))
        throw new ChatHostError('无法确认当前聊天的保存位置。');
    if (String(group ? group.chat_id : character.chat) !== snapshot.chatId) {
        throw new ChatHostError('聊天保存位置已改变，本次结果没有写回。');
    }
    const endpoint = group ? '/api/chats/group/save' : '/api/chats/save';
    const body = JSON.stringify(group
        ? { id: group.chat_id, chat: [header, ...chat], force: false }
        : { ch_name: character.name, avatar_url: character.avatar, file_name: character.chat, chat: [header, ...chat], force: false });
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
        if (!response.ok)
            throw new ChatHostError('聊天保存失败，服务端状态待确认；请检查连接或重新打开聊天。');
        const confirmation = await response.json();
        if (confirmation.ok !== true)
            throw new ChatHostError('酒馆没有确认聊天已保存，服务端状态待确认。');
        persisted = true;
        let current;
        try {
            current = requireSnapshot(snapshot);
        }
        catch {
            throw new ChatHostError('结果已保存到原聊天；当前聊天或楼层已变化，请重新打开原聊天确认。');
        }
        saved.message.mes = nextText;
        if (snapshot.swipeId !== null)
            saved.message.swipes[snapshot.swipeId] = nextText;
        try {
            await saved.embedded?.save(nextText);
        }
        catch {
            notifyRendered(snapshot.messageId, change);
            throw new ChatHostError('配图已保存到酒馆，但前端历史同步未获确认；请检查当前回合，暂勿重复 AI 处理。');
        }
        if (!sameTarget(snapshot, nextText)) {
            throw new ChatHostError('配图已保存，但前端或聊天已切换；请返回原聊天确认。');
        }
        // Capture the committed version before a view listener can change the active chat.
        const committed = takeSnapshot(current, snapshot.messageId);
        notifyRendered(snapshot.messageId, change);
        return committed;
    }
    catch (error) {
        if (error instanceof ChatHostError)
            throw error;
        throw new ChatHostError(persisted
            ? '结果已保存，但当前页面未能同步，请重新打开原聊天确认。'
            : '聊天保存未获确认，服务端状态待确认；插件未改动当前正文和界面。');
    }
    finally {
        clearTimeout(timer);
        saving = false;
    }
}
function historyIdentities(messages) {
    const counts = new Map();
    const current = new Map();
    messages.forEach((message, messageId) => {
        if (!message || message.is_user || message.is_system)
            return;
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
            if (!timestamp)
                continue;
            const parsed = Date.parse(timestamp);
            const date = typeof value === 'number' ? value : Number.isFinite(parsed) ? parsed : timestamp;
            const id = JSON.stringify([date, message.name ?? '', typeof message.original_avatar === 'string' ? message.original_avatar : '']);
            counts.set(id, (counts.get(id) ?? 0) + 1);
            if (version === active)
                current.set(messageId, id);
        }
    });
    // Imported replies can share a timestamp. Do not guess which history belongs
    // to them or fall back to a mutable floor/swipe index.
    return new Map([...current].filter(([, id]) => counts.get(id) === 1));
}
export function readAssistantMessages() {
    const context = host();
    const id = chatId(context);
    const scope = context.groupId !== undefined && context.groupId !== null && context.groupId !== ''
        ? JSON.stringify(['group', String(context.groupId)])
        : JSON.stringify(['character', context.characters[Number(context.characterId)]?.avatar ?? context.characterId]);
    const identities = historyIdentities(context.chat);
    return context.chat.flatMap((message, messageId) => {
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string')
            return [];
        try {
            const embedded = readEmbeddedTurn(messageId);
            return [{ scope, chatId: id, messageId, swipeId: currentSwipe(message),
                    historyId: embedded ? embedded.historyId : identities.get(messageId) ?? null,
                    turnId: embedded?.turnId ?? null, text: embedded?.text ?? message.mes }];
        }
        catch {
            // A swipe being created may not have its text yet; other floors can still render.
            return [];
        }
    });
}
/** Uses the host sanitizer; rendering transient text never writes it into chat storage. */
export function formatChatText(text, messageId) {
    const context = host();
    const message = context.chat[messageId];
    if (!message || typeof context.messageFormatting !== 'function')
        throw new ChatHostError('当前楼层无法渲染。');
    // At message 0 the native formatter may expand macros into chat.mes. A replaced
    // marker differs from mes and avoids this; otherwise use the transient-message path.
    const formattingId = messageId === 0 && text === message.mes ? -1 : messageId;
    return context.messageFormatting(text, message.name ?? '', Boolean(message.is_system), Boolean(message.is_user), formattingId);
}
export function watchChatRendering(callback) {
    const context = host();
    renderListeners.add(callback);
    const subscriptions = [];
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED',
        'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED',
        'GENERATION_ENDED', 'GENERATION_STOPPED']) {
        const event = context.eventTypes?.[name];
        if (!event)
            continue;
        const handler = (...args) => {
            try {
                callback(typeof args[0] === 'number' ? args[0] : undefined);
            }
            catch { /* Do not interrupt host rendering. */ }
        };
        context.eventSource.on(event, handler);
        subscriptions.push({ event, handler });
    }
    return () => {
        renderListeners.delete(callback);
        for (const { event, handler } of subscriptions)
            context.eventSource.removeListener(event, handler);
    };
}
