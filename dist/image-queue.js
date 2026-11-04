import { currentPreferences } from './settings.js';
const waiting = [];
let running = 0;
let concurrency = 1;
let draining = false;
const listeners = new Set();
function queueState() {
    return { generating: running > 0, active: running, queued: waiting.length, limit: concurrency };
}
/** Apply saved preferences once host storage is ready, then follow edits/imports/resets. */
export function bindImageQueuePreferences(signal) {
    if (signal.aborted)
        return;
    const update = () => { concurrency = currentPreferences().imageConcurrency; drain(); };
    window.addEventListener('witch-paintbox:preferences-changed', update, { signal });
    update();
}
export function onImageQueueChanged(listener) {
    listener(queueState());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function notifyQueue() {
    for (const listener of listeners) {
        try {
            listener(queueState());
        }
        catch { /* A launcher update must not interrupt the shared queue. */ }
    }
}
function cancelled() {
    return new DOMException('本次生图已取消。', 'AbortError');
}
function report(task, progress) {
    try {
        task.onProgress?.(progress);
    }
    catch {
        // A view update must not interrupt a generation or block the queue.
    }
}
function updatePositions() {
    for (const task of [...waiting]) {
        // Progress callbacks may cancel other waiting tasks.
        const position = waiting.indexOf(task) + 1;
        if (position && task.position !== position) {
            task.position = position;
            report(task, { state: 'queued', position });
        }
    }
    notifyQueue();
}
function drain() {
    if (draining)
        return;
    draining = true;
    try {
        while (waiting.length && running < concurrency) {
            const task = waiting.shift();
            ++running;
            void task.start().finally(() => { --running; drain(); });
        }
    }
    finally {
        draining = false;
        updatePositions();
    }
}
/** One shared FIFO for every image entry point; the operation includes response decoding. */
export function queueImageGeneration(operation, signal, onProgress) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(cancelled());
            return;
        }
        const cancel = () => {
            const index = waiting.indexOf(task);
            if (index < 0)
                return;
            waiting.splice(index, 1);
            signal.removeEventListener('abort', cancel);
            reject(cancelled());
            updatePositions();
        };
        const task = {
            position: 0,
            onProgress,
            async start() {
                signal.removeEventListener('abort', cancel);
                try {
                    if (signal.aborted)
                        throw cancelled();
                    report(task, { state: 'generating' });
                    updatePositions();
                    if (signal.aborted)
                        throw cancelled();
                    resolve(await operation());
                }
                catch (error) {
                    reject(error);
                }
            },
        };
        waiting.push(task);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted)
            cancel();
        drain();
    });
}
