import type { readAssistantMessages } from './chat-host.js';
import { parseImageMarkers, type ImageMarker } from './image-markers.js';

export type AssistantImageMessage = ReturnType<typeof readAssistantMessages>[number];
export interface MarkerEntry { marker: ImageMarker; key: string; historyKey: string | null }

/** Shared by inline image controls and the current-round list; persisted keys must remain stable. */
export function markerEntries(message: AssistantImageMessage): MarkerEntry[] {
  const markers = parseImageMarkers(message.text);
  const counts = new Map<string, number>();
  markers.forEach(marker => counts.set(marker.raw, (counts.get(marker.raw) ?? 0) + 1));
  const occurrences = new Map<string, number>();
  return markers.map(marker => {
    const occurrence = occurrences.get(marker.raw) ?? 0;
    occurrences.set(marker.raw, occurrence + 1);
    // If identical blocks are inserted/deleted, their old positions are ambiguous.
    const markerId = [marker.raw, counts.get(marker.raw), occurrence];
    return { marker,
      key: JSON.stringify([message.scope, message.chatId, message.messageId, message.swipeId ?? 0,
        ...(message.turnId ? [message.turnId] : []), ...markerId]),
      historyKey: message.historyId === null ? null : JSON.stringify([message.scope, message.chatId, message.historyId, ...markerId]),
    };
  });
}
