import { captureLatestAssistant, isChatReadyForImages, watchReplyGeneration } from './chat-host.js';
import { parseImageMarkers } from './image-markers.js';
import { installRequestActivity, requestQuietFor } from './request-activity.js';
import { currentPreferences } from './settings.js';
// Character cards often update variables right after a reply; wait until requests and host events stay quiet this long.
const QUIET = 3000;
const POLL = 500;
const ATTEMPTS = 3;
/** Runs AI 生图 on a finished reply, as if the user had clicked it, once the host and follow-up requests settle. */
export function autoProcessReplies(processor, signal) {
    let expecting = false;
    let attempts = 0;
    let activity = Date.now();
    let running = false;
    let timer;
    const enabled = () => currentPreferences().autoProcessReplies;
    function arm() {
        if (timer !== undefined || !expecting || signal.aborted)
            return;
        timer = setTimeout(() => { timer = undefined; void check(); }, POLL);
    }
    async function check() {
        if (running || !expecting)
            return;
        if (!enabled()) {
            expecting = false;
            return;
        }
        const now = Date.now();
        if (processor.busy || now - activity < QUIET || requestQuietFor(now) < QUIET) {
            arm();
            return;
        }
        running = true;
        try {
            // The quiet window restarts once the host itself is idle.
            if (!await isChatReadyForImages()) {
                activity = Date.now();
                return;
            }
            if (!expecting || signal.aborted)
                return;
            const before = await captureLatestAssistant();
            expecting = false;
            if (parseImageMarkers(before.text).length)
                return; // Continued or already illustrated replies keep their markers.
            if (await processor.process() || ++attempts >= ATTEMPTS)
                return;
            // A variable update may rewrite the reply mid-request, which blocks the write; wait for quiet again and retry.
            const after = await captureLatestAssistant().catch(() => null);
            if (after && after.text !== before.text && !parseImageMarkers(after.text).length) {
                expecting = true;
                activity = Date.now();
            }
        }
        catch {
            expecting = false;
        }
        finally {
            running = false;
            arm();
        }
    }
    function sync() {
        if (enabled())
            installRequestActivity();
        else
            expecting = false;
    }
    sync();
    window.addEventListener('witch-paintbox:preferences-changed', sync, { signal });
    let stop = () => { };
    try {
        stop = watchReplyGeneration(event => {
            if (event === 'reply') {
                if (!enabled())
                    return;
                expecting = true;
                attempts = 0;
            }
            else if (event === 'stopped' || event === 'reset')
                expecting = false;
            activity = Date.now();
            arm();
        });
    }
    catch { /* Without host events there is nothing to follow; manual AI 生图 still works. */ }
    signal.addEventListener('abort', () => { stop(); clearTimeout(timer); expecting = false; }, { once: true });
}
