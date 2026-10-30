import { captureLatestAssistant, isChatReadyForImages, readLatestAssistantReply, watchReplyGeneration } from './chat-host.js';
import { parseImageMarkers } from './image-markers.js';
import { currentPreferences } from './settings.js';
const QUIET = 3000;
const POLL = 500;
const ATTEMPTS = 3;
// Some helper versions omit the end event after an API error. Skip that reply instead of guessing it finished.
const HELPER_TIMEOUT = 10 * 60_000;
/** Automatic AI 生图 follows a completed reply and waits for helper jobs, host idle and stable floor text. */
export function autoProcessReplies(processor, signal, skipped) {
    if (signal.aborted)
        return;
    const helpers = new Map();
    let pending;
    let activity = Date.now();
    let running = false;
    let automatic;
    let timer;
    const enabled = () => !signal.aborted && currentPreferences().autoProcessReplies;
    function reset() {
        pending = undefined;
        automatic?.abort(); // Only cancel this automatic request; manual AI 生图 shares the processor.
        clearTimeout(timer);
        timer = undefined;
    }
    function arm() {
        if (timer !== undefined || !pending || !enabled() || running)
            return;
        timer = setTimeout(() => { timer = undefined; void check(); }, POLL);
    }
    async function check() {
        const task = pending;
        if (running || !task)
            return;
        if (!enabled()) {
            reset();
            return;
        }
        running = true;
        try {
            const now = Date.now();
            const stale = [...helpers].filter(([, time]) => now - time >= HELPER_TIMEOUT);
            if (stale.length) {
                for (const [id] of stale)
                    helpers.delete(id);
                reset();
                skipped('自动 AI 生图已跳过：酒馆助手的后续任务长时间没有结束确认，可稍后手动点击“AI生图”。');
                return;
            }
            if (helpers.size || processor.busy || !await isChatReadyForImages()) {
                activity = Date.now();
                return;
            }
            if (pending !== task || !enabled())
                return;
            const latest = readLatestAssistantReply();
            if (!latest || !task.target.matches(latest) || parseImageMarkers(latest.text).length) {
                if (pending === task)
                    pending = undefined;
                return;
            }
            // Poll text as well as events: scripts can update mes without emitting an edit event.
            if (task.text !== latest.text) {
                task.text = latest.text;
                activity = Date.now();
                return;
            }
            if (Date.now() - activity < QUIET)
                return;
            const seenActivity = activity;
            const before = await captureLatestAssistant();
            if (pending !== task || !enabled() || helpers.size || activity !== seenActivity)
                return;
            if (!task.target.matches(before)) {
                pending = undefined;
                return;
            }
            if (before.text !== task.text) {
                task.text = before.text;
                activity = Date.now();
                return;
            }
            const request = new AbortController();
            automatic = request;
            ++task.attempts;
            const done = await processor.process(undefined, { snapshot: before, signal: request.signal });
            automatic = undefined;
            if (pending !== task || !enabled())
                return;
            if (done || task.attempts >= ATTEMPTS) {
                pending = undefined;
                return;
            }
            const after = readLatestAssistantReply();
            // Retry only a changed version of this same reply, or an automatic run interrupted by a helper job.
            if (!after || !task.target.matches(after) || parseImageMarkers(after.text).length
                || !request.signal.aborted && after.text === before.text) {
                pending = undefined;
                return;
            }
            task.text = after.text;
            activity = Date.now();
        }
        catch {
            if (pending === task)
                pending = undefined;
        }
        finally {
            automatic = undefined;
            running = false;
            arm();
        }
    }
    function receive(event) {
        if (signal.aborted)
            return;
        if (event.kind === 'helper-start') {
            helpers.set(event.id, Date.now());
            automatic?.abort();
        }
        else if (event.kind === 'helper-progress') {
            if (!helpers.has(event.id))
                return; // Late tokens after an end event must not recreate a job.
            helpers.set(event.id, Date.now());
        }
        else if (event.kind === 'helper-end')
            helpers.delete(event.id);
        else if (event.kind === 'reset' || event.kind === 'stopped')
            reset();
        else if (event.kind === 'reply' && enabled()) {
            if (pending?.target.key !== event.target.key) {
                reset();
                pending = { target: event.target, attempts: 0 };
            }
        }
        activity = Date.now();
        arm();
    }
    let stop = () => { };
    let subscribed = false;
    function subscribe() {
        try {
            stop = watchReplyGeneration(receive);
            subscribed = true;
        }
        catch {
            if (enabled())
                skipped('当前宿主的回复事件不可用，自动 AI 生图尚未接入；手动 AI生图仍可使用。');
        }
    }
    subscribe(); // Track helper jobs even while disabled, so enabling cannot miss an already observed request.
    window.addEventListener('witch-paintbox:preferences-changed', () => {
        if (!enabled())
            reset();
        else if (!subscribed)
            subscribe();
    }, { signal });
    signal.addEventListener('abort', () => { stop(); reset(); helpers.clear(); }, { once: true });
}
