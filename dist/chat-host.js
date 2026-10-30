import { captureEmbeddedWrite, readEmbeddedTurn } from './embedded-chat.js';
import { isSifangEnvironment } from './sifang-host.js';
import { assertSifangSnapshot, captureSifangAssistant, isSifangChatReady, readSifangAssistantMessages, readSifangFloors, replaceSifangAssistant, sifangImageChatContext, watchSifangChat } from './sifang-chat.js';
class ChatHostError extends Error {
    fault = 'host';
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
/** Automatic generation waits for the native reply and any floor edits to finish. */
export async function isChatReadyForImages() {
    if (isSifangEnvironment())
        return isSifangChatReady();
    try {
        requireIdle(await nativeState());
        return true;
    }
    catch {
        return false;
    }
}
export function imageChatContext() {
    if (isSifangEnvironment())
        return sifangImageChatContext();
    try {
        const context = host();
        const id = chatId(context);
        const group = context.groupId !== undefined && context.groupId !== null && context.groupId !== '';
        const character = context.characters[Number(context.characterId)];
        if (!group && !character)
            return null;
        return {
            scope: JSON.stringify(group ? ['group', String(context.groupId)] : ['character', character.avatar ?? context.characterId]),
            name: group ? '当前群聊' : character.name,
            chatId: id, latestMessageId: context.chat.length - 1,
        };
    }
    catch {
        return null;
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
    if (isSifangEnvironment())
        return captureSifangAssistant();
    const state = await nativeState();
    requireIdle(state);
    const context = host();
    const id = latestAssistant(context);
    if (!context.chat[id].mes.trim())
        throw new ChatHostError('最新 AI 回复为空。');
    return takeSnapshot(context, id);
}
export async function assertChatSnapshot(snapshot) {
    if (isSifangEnvironment()) {
        await assertSifangSnapshot(snapshot);
        return;
    }
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
function jsonRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : null;
}
/** The read endpoint returns a header followed by messages, including full swipe history. */
function matchesSavedChat(value, expected, metadata, snapshot) {
    if (!Array.isArray(value) || value.length !== expected.length + 1)
        return false;
    const storedMetadata = jsonRecord(jsonRecord(value[0])?.chat_metadata);
    if (!storedMetadata || (metadata.integrity !== undefined && storedMetadata.integrity !== metadata.integrity))
        return false;
    // Compare narrative across the chat, but do not compare unloaded historical swipe slots.
    if (!expected.every((message, index) => {
        const stored = jsonRecord(value[index + 1]);
        return stored && stored.mes === message.mes && stored.name === message.name
            && Boolean(stored.is_user) === Boolean(message.is_user)
            && Boolean(stored.is_system) === Boolean(message.is_system);
    }))
        return false;
    const target = jsonRecord(value[snapshot.messageId + 1]);
    return snapshot.swipeId === null
        ? !Array.isArray(target.swipes)
        : (target.swipe_id ?? 0) === snapshot.swipeId && Array.isArray(target.swipes)
            && target.swipes[snapshot.swipeId] === expected[snapshot.messageId].mes;
}
/** Commit only after the host confirms storage; updating image controls never rebuilds the floor. */
export async function replaceAssistantMessage(snapshot, result, signal) {
    const nextText = result.text;
    if (typeof nextText !== 'string' || !nextText.trim())
        throw new ChatHostError('处理结果为空，原回复已保留。');
    if (isSifangEnvironment())
        return replaceSifangAssistant(snapshot, nextText, signal);
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
        if (!response.ok)
            throw new ChatHostError('聊天保存失败，服务端状态待确认；请检查连接或重新打开聊天。');
        const confirmation = jsonRecord(await response.json().catch(() => null));
        if (confirmation?.error || confirmation?.ok === false || confirmation?.success === false) {
            throw new ChatHostError('酒馆返回了保存失败的回执，插件未改动当前正文和界面。');
        }
        // ST 1.13.5 uses { result: 'ok' } for individual chats; newer ST and TT use { ok: true }.
        if (confirmation?.ok !== true && confirmation?.result !== 'ok') {
            // Unknown replies need proof from the same saved chat; never assume HTTP 200
            // means saved or repeat the write.
            const readback = await fetch(readEndpoint, {
                method: 'POST', headers, body: readBody, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
            });
            const stored = readback.ok ? await readback.json().catch(() => null) : null;
            if (!matchesSavedChat(stored, chat, header.chat_metadata, snapshot)) {
                throw new ChatHostError('保存回执异常，回读也未能确认配图已保存；请重新打开当前聊天检查，暂勿重复 AI 处理。');
            }
        }
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
    if (isSifangEnvironment())
        return readSifangAssistantMessages();
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
    if (isSifangEnvironment())
        throw new ChatHostError('独立前端的正文由原生配图接口渲染。');
    const context = host();
    const message = context.chat[messageId];
    if (!message || typeof context.messageFormatting !== 'function')
        throw new ChatHostError('当前楼层无法渲染。');
    // At message 0 the native formatter may expand macros into chat.mes. A replaced
    // marker differs from mes and avoids this; otherwise use the transient-message path.
    const formattingId = messageId === 0 && text === message.mes ? -1 : messageId;
    return context.messageFormatting(text, message.name ?? '', Boolean(message.is_system), Boolean(message.is_user), formattingId);
}
/** Read only the current final floor for stability polling; this is not a write-authorizing snapshot. */
export function readLatestAssistantReply() {
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
function replyTarget(messageId) {
    if (isSifangEnvironment()) {
        const context = sifangImageChatContext();
        const floor = readSifangFloors().at(-1);
        if (!context || !floor || floor.role !== 'assistant' || messageId !== undefined && floor.floor !== messageId)
            return null;
        return {
            key: JSON.stringify([context.chatId, floor.node]),
            matches: snapshot => snapshot.chatId === context.chatId && snapshot.messageId === floor.floor
                && sifangImageChatContext()?.chatId === context.chatId && readSifangFloors().at(-1)?.node === floor.node,
        };
    }
    const context = host();
    const id = messageId ?? context.chat.length - 1;
    const message = context.chat[id];
    if (id !== context.chat.length - 1 || !message || message.is_user || message.is_system || !message.mes?.trim())
        return null;
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
export function watchReplyGeneration(callback) {
    if (isSifangEnvironment()) {
        let previous = '';
        return watchSifangChat((messageId, event) => {
            const latest = readSifangFloors().at(-1);
            const fingerprint = JSON.stringify([sifangImageChatContext()?.chatId, latest?.node, latest?.version, latest?.raw]);
            // Snapshot reads refresh this cache too; unchanged reads are not new floor activity.
            if (event === 'MESSAGE_UPDATED' && fingerprint === previous)
                return;
            previous = fingerprint;
            if (event === 'CHAT_CHANGED' || event === 'MESSAGE_DELETED')
                callback({ kind: 'reset' });
            else if (event === 'GENERATION_ENDED') {
                const target = replyTarget(messageId);
                if (target)
                    callback({ kind: 'reply', target });
            }
            else
                callback({ kind: 'activity' });
        });
    }
    const context = host();
    const source = context.eventSource;
    if (!source?.on || !source.removeListener || !context.eventTypes?.MESSAGE_RECEIVED || !context.eventTypes.GENERATION_STARTED) {
        throw new ChatHostError('当前宿主未提供回复完成事件。');
    }
    const subscriptions = [];
    const reorder = () => {
        for (const { event, handler, last } of subscriptions)
            if (last)
                source.makeLast?.(event, handler);
    };
    function listen(event, action, last = true) {
        if (!event)
            return;
        const handler = (...args) => { try {
            action(...args);
        }
        catch { /* Never interrupt host generation. */ } };
        const ordered = last ? source.makeLast : source.makeFirst;
        (ordered ?? source.on).call(source, event, handler);
        subscriptions.push({ event, handler, last });
    }
    let expecting = false;
    const replyTypes = new Set(['normal', 'swipe', 'regenerate', 'continue', 'append', 'appendFinal']);
    listen(context.eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun)
            return;
        reorder(); // Include card scripts that subscribed after this extension loaded.
        if (type === 'quiet') {
            callback({ kind: 'activity' });
            return;
        }
        expecting = typeof type === 'string' && replyTypes.has(type);
        callback({ kind: 'reset' });
    }, false);
    listen(context.eventTypes.MESSAGE_RECEIVED, (messageId, type) => {
        const eligible = expecting && (type === undefined || typeof type === 'string' && replyTypes.has(type));
        if (eligible) {
            expecting = false;
            const target = typeof messageId === 'number' ? replyTarget(messageId) : null;
            if (target) {
                callback({ kind: 'reply', target });
                return;
            }
        }
        callback({ kind: 'activity' });
    });
    listen(context.eventTypes.GENERATION_STOPPED, id => {
        // Tavern Helper uses this same native event, with a string generation ID.
        if (typeof id === 'string' && id)
            callback({ kind: 'helper-end', id });
        else {
            expecting = false;
            callback({ kind: 'stopped' });
        }
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
    const helperStart = (id) => {
        if (typeof id === 'string' && id) {
            reorder();
            callback({ kind: 'helper-start', id });
        }
    };
    listen('js_generation_requested', helperStart, false);
    listen('js_generation_started', helperStart, false);
    listen('js_generation_ended', (_text, id) => { if (typeof id === 'string' && id)
        callback({ kind: 'helper-end', id }); });
    listen('js_stream_token_received_fully', (_text, id) => { if (typeof id === 'string' && id)
        callback({ kind: 'helper-progress', id }); }, false);
    return () => { for (const { event, handler } of subscriptions)
        source.removeListener(event, handler); };
}
export function watchChatRendering(callback) {
    if (isSifangEnvironment())
        return watchSifangChat((messageId, event) => callback(messageId, undefined, event));
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
                callback(typeof args[0] === 'number' ? args[0] : undefined, undefined, name);
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
