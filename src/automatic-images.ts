import { imageChatContext, isChatReadyForImages } from './chat-host.js';
import type { AssistantImageMessage, MarkerEntry } from './image-marker-history.js';
import { currentPreferences } from './settings.js';
import { emitPetEvent } from './pet-events.js';
import { isImageSizeModeSaving } from './model-settings.js';

export interface AutomaticImage { message: AssistantImageMessage; entry: MarkerEntry }

/** Observe new source markers, never synthetic button clicks or historical DOM remounts. */
export function automaticImages(handlers: {
  mounted(candidate: AutomaticImage): boolean;
  generate(candidate: AutomaticImage, signal: AbortSignal): Promise<void>;
}) {
  const seen = new Set<string>();
  const waiting = new Map<string, AutomaticImage & { readyAt: number }>();
  let identity = '';
  let mode = '';
  let active: { candidate: AutomaticImage; controller: AbortController } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let reported = '0 false';

  function notifyPet() {
    const state = `${waiting.size} ${active !== null}`;
    if (state === reported) return;
    reported = state;
    emitPetEvent({ type: 'auto', waiting: waiting.size, active: active !== null });
  }
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    waiting.clear();
    active?.controller.abort();
    notifyPet();
  }
  // Retries while the host is still busy keep a floor, so a 0-second interval never spins.
  const RETRY_FLOOR = 250;
  function interval(): number { return currentPreferences().autoImageDelay * 1000; }
  function arm(delay = interval()) {
    if (disposed || active || timer !== undefined || !waiting.size) return;
    timer = setTimeout(() => { timer = undefined; void next(); }, delay);
  }
  async function next() {
    if (disposed || active) return;
    const pending = [...waiting.values()].sort((a, b) => a.message.messageId - b.message.messageId || a.entry.marker.start - b.entry.marker.start)[0];
    if (!pending) return;
    if (pending.readyAt > Date.now()) { arm(pending.readyAt - Date.now()); return; }
    if (!handlers.mounted(pending)) return; // A later mount calls update() again.
    const controller = new AbortController();
    const job = { candidate: pending, controller };
    active = job;
    let retry = false;
    try {
      if (!await isChatReadyForImages()) { retry = true; return; }
      if (controller.signal.aborted || waiting.get(pending.entry.key) !== pending || pending.readyAt > Date.now()) return;
      if (isImageSizeModeSaving()) { retry = true; return; } // Keep this unpaid job queued until both controls finish synchronizing.
      waiting.delete(pending.entry.key);
      notifyPet();
      await handlers.generate(pending, controller.signal);
    } catch {
      // Inline controls display failures. Never retry a paid generation automatically.
      waiting.delete(pending.entry.key);
    } finally {
      if (active === job) active = null;
      notifyPet();
      arm(retry ? Math.max(interval(), RETRY_FLOOR) : interval());
    }
  }
  return {
    settled() { waiting.forEach(item => { item.readyAt = Date.now() + interval(); }); },
    update(candidates: AutomaticImage[], parsingEnabled: boolean) {
      if (disposed) return;
      const context = imageChatContext();
      const settings = currentPreferences();
      const nextIdentity = context ? JSON.stringify([context.scope, context.chatId]) : '';
      const enabled = parsingEnabled && settings.autoGenerateImages && Boolean(context);
      const nextMode = String(enabled);
      if (identity !== nextIdentity || mode !== nextMode) {
        cancel();
        seen.clear();
        candidates.forEach(item => seen.add(item.entry.key));
        identity = nextIdentity;
        mode = nextMode;
        return; // Opening a chat or enabling the option establishes a baseline, without billing.
      }
      const eligible = new Map(candidates.filter(item => item.message.messageId === context?.latestMessageId)
        .map(item => [item.entry.key, item]));
      if (active) {
        const current = candidates.find(item => item.entry.key === active!.candidate.entry.key);
        if (!enabled || !current || current.message.text !== active.candidate.message.text) active.controller.abort();
      }
      for (const [key, pending] of waiting) {
        const current = eligible.get(key);
        if (!enabled || !current) waiting.delete(key);
        else if (current.message.text !== pending.message.text) {
          waiting.set(key, { ...current, readyAt: Date.now() + interval() });
        }
      }
      for (const candidate of candidates) {
        if (seen.has(candidate.entry.key)) continue;
        seen.add(candidate.entry.key);
        if (enabled && eligible.has(candidate.entry.key)) waiting.set(candidate.entry.key, { ...candidate, readyAt: Date.now() + interval() });
      }
      notifyPet();
      arm();
    },
    dispose() { disposed = true; cancel(); seen.clear(); },
  };
}
