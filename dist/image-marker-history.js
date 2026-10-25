import { parseImageMarkers } from './image-markers.js';
/** Shared by inline image controls and the current-round list; persisted keys must remain stable. */
export function markerEntries(message) {
    const markers = parseImageMarkers(message.text);
    const counts = new Map();
    markers.forEach(marker => counts.set(marker.raw, (counts.get(marker.raw) ?? 0) + 1));
    const occurrences = new Map();
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
