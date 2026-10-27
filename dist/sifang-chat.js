import { requireSifangHost } from './sifang-host.js';
const listeners = new Set();
const snapshots = new WeakMap();
let floors = [];
let save = null;
let identity = null;
let valid = false;
let saving = false;
let streaming = false;
let activity = 0;
const invalidNodes = new Set();
const invalidFloors = new Set();
let revision = 0;
let lifecycle;
let initializing;
let currentRefresh;
function chatId(value) { return JSON.stringify(['sifang', value.id, value.volume]); }
function sameSave(a, b) { return a.id === b.id && a.volume === b.volume; }
function belongs(floor, value) { return floor.saveId === value.id && floor.volume === value.volume; }
/** Only character metadata comes from the compatibility context; body text is always native. */
function characterIdentity() {
    const context = globalThis.SillyTavern?.getContext();
    const character = context?.characters?.[Number(context.characterId)];
    const name = character?.name || context?.name2;
    const key = character?.avatar || name;
    return key ? { scope: JSON.stringify(['character', key]), name: name || key } : null;
}
function checkFloor(floor) {
    if (!Number.isInteger(floor.floor) || floor.floor < 0 || !floor.node || !floor.saveId
        || typeof floor.raw !== 'string' || typeof floor.busy !== 'boolean') {
        throw new Error('独立前端楼层接口版本不匹配，请更新独立前端。');
    }
}
function requireIdle(floor) {
    if (saving || floor?.busy)
        throw new Error('请等当前回复与保存完成后再处理。');
}
function emit(messageId, event) {
    for (const listener of listeners) {
        try {
            listener(messageId, event);
        }
        catch { /* A view cannot undo a persisted floor. */ }
    }
}
function refresh(event, messageId) {
    const pending = { promise: readFloors(event, messageId), settled: false };
    currentRefresh = pending;
    void pending.promise.then(() => { pending.settled = true; }, () => { pending.settled = true; });
    return pending.promise;
}
async function readFloors(event, messageId) {
    const host = requireSifangHost();
    const ticket = ++revision;
    const seenActivity = activity;
    const before = await host.game.save();
    if (lifecycle?.aborted || ticket !== revision)
        return;
    if (!before?.id) {
        valid = false;
        floors = [];
        save = null;
        identity = null;
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
    if (lifecycle?.aborted || ticket !== revision)
        return;
    if (!after || !sameSave(before, after)) {
        valid = false;
        emit(undefined, 'CHAT_CHANGED');
        throw new Error('存档已切换，正在等待当前正文同步。');
    }
    const next = loaded.filter((floor) => floor !== null);
    next.forEach(checkFloor);
    if (next.length !== line.length || next.some((floor, index) => !belongs(floor, before) || floor.node !== line[index].node)) {
        throw new Error('楼层已变化，正在等待当前正文同步。');
    }
    const switched = !save || !sameSave(save, after);
    floors = next.sort((a, b) => a.floor - b.floor);
    save = after;
    identity = characterIdentity();
    valid = true;
    streaming = activity !== seenActivity || next.some(floor => floor.busy);
    invalidNodes.clear();
    invalidFloors.clear();
    emit(messageId, switched ? 'CHAT_CHANGED' : event);
}
/** Subscribe before the first read, so changes during initialization invalidate its snapshot. */
export async function initializeSifangChat(signal) {
    if (signal.aborted)
        return;
    if (lifecycle === signal && initializing)
        return initializing;
    const host = requireSifangHost();
    lifecycle = signal;
    const events = {
        floor: 'GENERATION_ENDED', swipe: 'MESSAGE_SWIPED', edit: 'MESSAGE_UPDATED',
        remove: 'MESSAGE_DELETED', save: 'CHAT_CHANGED',
    };
    const unsubs = Object.entries(events).map(([native, event]) => host.on(native, payload => {
        if (signal.aborted)
            return;
        ++activity;
        const data = payload;
        const messageId = data?.floor;
        const changedSave = save && (data?.saveId && data.saveId !== save.id
            || data && 'volume' in data && data.volume !== save.volume);
        if (native === 'save' || changedSave) {
            valid = false;
            emit(undefined, 'CHAT_CHANGED');
        }
        else if (native === 'edit' || native === 'swipe' || native === 'remove') {
            // Only the changed floor is unavailable during its read. Other floors'
            // queued images keep their valid identity and are not cancelled.
            if (typeof messageId === 'number')
                invalidFloors.add(messageId);
            if (typeof data?.node === 'string')
                invalidNodes.add(data.node);
            if (Array.isArray(data?.removed))
                data.removed.forEach(node => { if (typeof node === 'string')
                    invalidNodes.add(node); });
        }
        void refresh(event, typeof messageId === 'number' ? messageId : undefined)
            .catch(error => { if (!signal.aborted)
            void host.ui.toast(error instanceof Error ? error.message : '正文同步失败。', 'fail').catch(() => { }); });
    }));
    unsubs.push(host.on('stream', () => { if (!signal.aborted) {
        streaming = true;
        ++activity;
    } }));
    signal.addEventListener('abort', () => {
        unsubs.forEach(stop => stop());
        if (lifecycle !== signal)
            return;
        ++revision;
        valid = false;
        streaming = false;
        floors = [];
        save = null;
        identity = null;
        initializing = undefined;
        currentRefresh = undefined;
        invalidNodes.clear();
        invalidFloors.clear();
    }, { once: true });
    initializing = refresh('CHAT_CHANGED').catch(error => {
        // Settings can open before a game has been bound. Keep subscriptions alive
        // so the first native save/floor event can populate the empty cache.
        if (error instanceof Error && error.message.includes('no session bound'))
            return;
        throw error;
    });
    return initializing;
}
export function readSifangFloors() {
    return valid ? floors.filter(floor => !invalidNodes.has(floor.node) && !invalidFloors.has(floor.floor)) : [];
}
/** An edited floor can be temporarily unreadable while its unchanged markers are being reloaded. */
export function isSifangFloorPending(saveId, node) {
    return Boolean(valid && save?.id === saveId && currentRefresh && !currentRefresh.settled
        && floors.some(floor => floor.node === node && (invalidNodes.has(node) || invalidFloors.has(floor.floor))));
}
/** Follow replacements of the pending read; callers then check the final marker identity normally. */
export async function awaitSifangChatRefresh() {
    if (currentRefresh?.settled)
        return;
    while (currentRefresh) {
        const pending = currentRefresh;
        try {
            await pending.promise;
        }
        catch (error) {
            if (currentRefresh === pending)
                throw error;
        }
        if (currentRefresh === pending)
            return;
    }
}
export function sifangImageChatContext() {
    return valid && save && identity
        ? { ...identity, chatId: chatId(save), latestMessageId: floors.at(-1)?.floor ?? -1 } : null;
}
export function readSifangAssistantMessages() {
    const context = sifangImageChatContext();
    if (!context)
        return [];
    return readSifangFloors().filter(floor => floor.role === 'assistant').map(floor => ({
        scope: context.scope, chatId: context.chatId, messageId: floor.floor,
        swipeId: Math.max(0, floor.version - 1), historyId: floor.node, turnId: floor.node, text: floor.raw,
    }));
}
export function watchSifangChat(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}
function snapshotFor(floor, latestNode = floors.at(-1)?.node ?? floor.node, length = floors.length) {
    const snapshot = Object.freeze({
        chatId: chatId({ id: floor.saveId, volume: floor.volume, name: '' }), messageId: floor.floor,
        swipeId: Math.max(0, floor.version - 1), text: floor.raw,
    });
    snapshots.set(snapshot, { floor, latestNode, length });
    return snapshot;
}
export async function isSifangChatReady() {
    try {
        const ticket = activity;
        const latest = await requireSifangHost().game.floor();
        if (ticket !== activity)
            return false;
        if (latest)
            checkFloor(latest);
        requireIdle(latest);
        if (!latest?.busy)
            streaming = false;
        return Boolean(valid && !streaming && save && latest?.role === 'assistant' && belongs(latest, save)
            && !invalidNodes.has(latest.node) && !invalidFloors.has(latest.floor));
    }
    catch {
        return false;
    }
}
export async function captureSifangAssistant() {
    await refresh('MESSAGE_UPDATED');
    const host = requireSifangHost();
    const latest = await host.game.floor();
    if (latest)
        checkFloor(latest);
    requireIdle(latest);
    if (!latest || !save || !belongs(latest, save))
        throw new Error('当前聊天还没有可处理的 AI 回复。');
    if (latest.role !== 'assistant')
        throw new Error('最新一楼是用户消息，请等 AI 回复完成后再处理。');
    const floor = readSifangFloors().find(item => item.node === latest.node && item.floor === latest.floor && item.raw === latest.raw);
    if (!floor)
        throw new Error('最新回复已变化，请稍后重试。');
    requireIdle(floor);
    if (!floor.raw.trim())
        throw new Error('最新 AI 回复为空。');
    return snapshotFor(floor, latest.node);
}
export async function assertSifangSnapshot(snapshot) {
    const state = snapshots.get(snapshot);
    if (!state)
        throw new Error('聊天或原回复已发生变化，本次结果没有写回。');
    const saved = state.floor;
    const host = requireSifangHost();
    const [current, line, active, latest] = await Promise.all([
        host.game.floor(saved.floor), host.game.floors(), host.game.save(), host.game.floor(),
    ]);
    const lastAssistant = [...line].reverse().find(item => item.role === 'assistant');
    if (current)
        checkFloor(current);
    if (latest)
        checkFloor(latest);
    requireIdle(latest);
    requireIdle(current);
    if (!active || !current || !belongs(saved, active) || !belongs(current, active) || !latest || !belongs(latest, active)
        || current.node !== saved.node || current.raw !== snapshot.text || lastAssistant?.node !== saved.node
        || latest.role !== 'assistant' || latest.node !== state.latestNode || line.length !== state.length) {
        throw new Error('聊天或原回复已发生变化，本次结果没有写回。');
    }
    return saved;
}
export async function replaceSifangAssistant(snapshot, text, signal) {
    const saved = await assertSifangSnapshot(snapshot);
    signal?.throwIfAborted();
    if (text === snapshot.text)
        return snapshot;
    saving = true;
    let committed;
    try {
        committed = await requireSifangHost().game.replaceText({
            saveId: saved.saveId, node: saved.node, volume: saved.volume, expectedRaw: snapshot.text, raw: text,
        });
        checkFloor(committed);
        if (committed.node !== saved.node || committed.saveId !== saved.saveId || committed.volume !== saved.volume || committed.raw !== text) {
            throw new Error('独立前端未返回原楼层的保存确认，请重新打开该楼层检查。');
        }
    }
    finally {
        saving = false;
    }
    await refresh('MESSAGE_UPDATED', saved.floor);
    return snapshotFor(committed);
}
