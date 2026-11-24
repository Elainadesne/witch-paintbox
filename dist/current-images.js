import { assertChatSnapshot, captureLatestAssistant, readAssistantMessages } from './chat-host.js';
import { loadImageHistory } from './image-history.js';
import { markerEntries } from './image-marker-history.js';
function signatureOf(message) {
    return JSON.stringify([message.scope, message.chatId, message.messageId, message.swipeId, message.historyId, message.turnId, message.text]);
}
/** Reads the actual latest assistant reply, including images outside the currently rendered DOM. */
export async function getCurrentRoundImages() {
    const snapshot = await captureLatestAssistant();
    const message = readAssistantMessages().find(item => item.messageId === snapshot.messageId
        && item.chatId === snapshot.chatId && item.swipeId === snapshot.swipeId && item.text === snapshot.text);
    if (!message)
        throw new Error('最新一楼还没落稳呢，稍等一秒再点刷新吧。');
    const signature = signatureOf(message);
    const groups = await Promise.all(markerEntries(message).map(async ({ marker, historyKey }) => {
        if (!historyKey)
            return [];
        const history = await loadImageHistory(historyKey);
        return history.map(entry => ({ entry, summary: marker.summary, scenePrompt: entry.scenePrompt ?? marker.prompt }));
    }));
    // A delayed IndexedDB read must not show images from another chat, swipe, or edited floor.
    await assertChatSnapshot(snapshot);
    const current = readAssistantMessages().at(-1);
    if (!current || signatureOf(current) !== signature)
        throw new Error('刚才切换聊天或者最新一楼变了，刷新一下本轮生图吧。');
    const images = groups.flat().sort((a, b) => b.entry.createdAt - a.entry.createdAt || b.entry.id.localeCompare(a.entry.id));
    // Include the record set so save/delete events invalidate the view even when the floor is unchanged.
    return { images, signature: JSON.stringify([signature, images.map(({ entry }) => [entry.id, entry.createdAt])]) };
}
