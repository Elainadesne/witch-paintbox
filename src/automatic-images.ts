import { imageChatContext, isChatReadyForImages } from './chat-host.js';
import type { AssistantImageMessage, MarkerEntry } from './image-marker-history.js';
import { currentPreferences } from './settings.js';
import { emitPetEvent } from './pet-events.js';
import { isImageSizeModeSaving } from './model-settings.js';

export interface AutomaticImage { message: AssistantImageMessage; entry: MarkerEntry }
interface ActiveImage { candidate: AutomaticImage; controller: AbortController }

/** Observe new source markers, never synthetic button clicks or historical DOM remounts. */
export function automaticImages(handlers: {
  mounted(candidate: AutomaticImage): boolean;
  generate(candidate: AutomaticImage, signal: AbortSignal): Promise<void>;
}) {
  const seen = new Set<string>();
  const waiting = new Map<string, AutomaticImage & { readyAt: number }>();
  const active = new Map<string, ActiveImage>();
  let identity = '';
  let mode = '';
  let revision = 0;
  let checking = false;
  let nextStart = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let reported = '0 false';

  function notifyPet() {
    const state = `${waiting.size} ${active.size > 0}`;
    if (state === reported) return;
    reported = state;
    emitPetEvent({ type: 'auto', waiting: waiting.size, active: active.size > 0 });
  }
  function cancel() {
    ++revision;
    clearTimeout(timer);
    timer = undefined;
    waiting.clear();
    for (const job of active.values()) job.controller.abort();
    active.clear();
    nextStart = 0;
    notifyPet();
  }
  // Retries while the host is still busy keep a floor, so a 0-second interval never spins.
  const RETRY_FLOOR = 250;
  function interval(): number { return currentPreferences().autoImageDelay * 1000; }
  function full(): boolean { return active.size >= currentPreferences().imageConcurrency; }
  function arm(delay = 0) {
    if (disposed || checking || full() || timer !== undefined || !waiting.size) return;
    timer = setTimeout(() => { timer = undefined; void next(); }, Math.max(delay, nextStart - Date.now(), 0));
  }
  async function generate(key: string, job: ActiveImage) {
    try {
      await handlers.generate(job.candidate, job.controller.signal);
    } catch {
      // Inline controls display failures. Never retry a paid generation automatically.
    } finally {
      // An old chat's completion must not release a new chat's slot or change its interval.
      if (active.get(key) === job) {
        active.delete(key);
        nextStart = Math.max(nextStart, Date.now() + interval());
        notifyPet();
        arm();
      }
    }
  }
  async function next() {
    if (disposed || checking || full()) return;
    const pending = [...waiting.values()].sort((a, b) => a.message.messageId - b.message.messageId || a.entry.marker.start - b.entry.marker.start)[0];
    if (!pending) return;
    if (pending.readyAt > Date.now()) { arm(pending.readyAt - Date.now()); return; }
    if (!handlers.mounted(pending)) return; // A later mount calls update() again.
    const before = revision;
    checking = true;
    let retry = false;
    try {
      if (!await isChatReadyForImages()) { retry = true; return; }
      if (disposed || before !== revision || waiting.get(pending.entry.key) !== pending || full()) return;
      if (pending.readyAt > Date.now()) return;
      if (isImageSizeModeSaving()) { retry = true; return; }
      waiting.delete(pending.entry.key);
      const job = { candidate: pending, controller: new AbortController() };
      active.set(pending.entry.key, job);
      nextStart = Date.now() + interval();
      notifyPet();
      void generate(pending.entry.key, job);
    } catch {
      // A readiness failure must not discard an unpaid job or start a request blindly.
      retry = true;
    } finally {
      checking = false;
      arm(retry ? Math.max(interval(), RETRY_FLOOR) : 0);
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
      for (const [key, job] of active) {
        const current = eligible.get(key);
        if (!enabled || !current || current.message.text !== job.candidate.message.text) job.controller.abort();
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
