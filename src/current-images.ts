import { assertChatSnapshot, captureLatestAssistant, readAssistantMessages } from './chat-host.js';
import { loadImageHistory, type ImageHistoryEntry } from './image-history.js';
import { markerEntries, type AssistantImageMessage } from './image-marker-history.js';

export interface CurrentRoundImage {
  entry: ImageHistoryEntry;
  summary: string;
  scenePrompt: string;
}

function signatureOf(message: AssistantImageMessage): string {
  return JSON.stringify([message.scope, message.chatId, message.messageId, message.swipeId, message.historyId, message.turnId, message.text]);
}

/** Reads the actual latest assistant reply, including images outside the currently rendered DOM. */
export async function getCurrentRoundImages(): Promise<{ images: CurrentRoundImage[]; signature: string }> {
  const snapshot = await captureLatestAssistant();
  const message = readAssistantMessages().find(item => item.messageId === snapshot.messageId
    && item.chatId === snapshot.chatId && item.swipeId === snapshot.swipeId && item.text === snapshot.text);
  if (!message) throw new Error('最新回复尚未就绪，请稍后刷新本轮生图。');
  const signature = signatureOf(message);
  const groups = await Promise.all(markerEntries(message).map(async ({ marker, historyKey }) => {
    if (!historyKey) return [];
    const history = await loadImageHistory(historyKey);
    return history.map(entry => ({ entry, summary: marker.summary, scenePrompt: entry.scenePrompt ?? marker.prompt }));
  }));
  // A delayed IndexedDB read must not show images from another chat, swipe, or edited floor.
  await assertChatSnapshot(snapshot);
  const current = readAssistantMessages().at(-1);
  if (!current || signatureOf(current) !== signature) throw new Error('当前聊天或最新回复已变化，请刷新本轮生图。');
  const images = groups.flat().sort((a, b) => b.entry.createdAt - a.entry.createdAt || b.entry.id.localeCompare(a.entry.id));
  // Include the record set so save/delete events invalidate the view even when the floor is unchanged.
  return { images, signature: JSON.stringify([signature, images.map(({ entry }) => [entry.id, entry.createdAt])]) };
}
