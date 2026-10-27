// The conductor: the plugin's real tasks (pet events and the image queue's totals) turned into her acts.
import { onImageQueueChanged } from '../image-queue.js';
import { onPetEvent } from '../pet-events.js';
const PAPER = 832 / 1216;
/** Her line for an image fault: reference errors and the interface's own failures; none for the rest. */
export function faultLine(fault) {
    if (fault === 'reference')
        return 'reference';
    if (fault === 'network' || fault === 'auth' || fault === 'quota' || fault === 'busy' || fault === 'timeout' || fault === 'unknown')
        return 'network';
    return null;
}
export function conduct(m, acts, speech, hooks, signal) {
    const tasks = new Map();
    let queued = 0, autoWaiting = 0, stopped = false, processId = null;
    const sync = () => {
        let drawing = null;
        const waiting = [];
        for (const [id, task] of tasks) {
            if (task.phase === 'generating' && !drawing)
                drawing = { id, aspect: task.aspect };
            else
                waiting.push({ id, aspect: task.aspect });
        }
        // (how long the one under way has taken: a long wait sends her to sleep over the easel)
        if (!drawing)
            m.st.waitFrom = 0;
        else if (drawing.id !== acts.work.drawing?.id || !m.st.waitFrom)
            m.st.waitFrom = performance.now();
        acts.work = { drawing, waiting };
        // (the blank sheets behind the one under way: the queue's waiting ones and the automatic ones not started)
        m.st.box.queued = queued + autoWaiting;
        void acts.refresh();
        hooks.wake();
    };
    const stopQueue = onImageQueueChanged(state => {
        if (stopped)
            return;
        queued = state.queued;
        m.st.box.queued = queued + autoWaiting;
        hooks.status(state.generating, state.queued);
        hooks.wake();
    });
    const handle = (event) => {
        if (stopped)
            return;
        switch (event.type) {
            case 'process':
                if (event.phase === 'reading' || processId !== event.id) {
                    processId = event.id;
                    hooks.readTarget(event.floor ?? null);
                    void acts.read();
                }
                else if (event.floor !== undefined)
                    hooks.readTarget(event.floor);
                break;
            case 'image': {
                const task = tasks.get(event.id);
                if (event.phase === 'start') {
                    const aspect = event.width && event.height ? event.width / event.height : PAPER;
                    tasks.set(event.id, { source: event.source, phase: 'start', aspect });
                }
                else if (task) {
                    if (event.width && event.height)
                        task.aspect = event.width / event.height;
                    if (event.phase === 'queued') {
                        if (task.phase !== 'queued')
                            speech.say('queued');
                        task.phase = 'queued';
                    }
                    else {
                        task.phase = 'generating';
                        speech.say((event.columns ?? 0) >= 2 ? 'columns' : 'drawing');
                    }
                }
                else {
                    // (a task seen first in the middle: take it as it is)
                    tasks.set(event.id, { source: event.source, phase: event.phase, aspect: event.width && event.height ? event.width / event.height : PAPER });
                }
                sync();
                break;
            }
            case 'end':
                if (event.task === 'process') {
                    if (processId !== null && processId !== event.id)
                        break;
                    processId = null;
                    if (event.result === 'done')
                        acts.found(event.message);
                    else if (event.result === 'failed') {
                        acts.stopReading();
                        void acts.fail(faultLine(event.fault), event.message, event.fault);
                    }
                    else
                        acts.stopReading();
                    hooks.readTarget(null);
                    break;
                }
                else {
                    const task = tasks.get(event.id);
                    tasks.delete(event.id);
                    const floor = event.source === 'floor' || event.source === 'auto' || task?.source === 'floor' || task?.source === 'auto';
                    if (event.result === 'done' && event.picture) {
                        sync();
                        void acts.bloom(event.id, floor, event.picture);
                    }
                    else if (event.result === 'failed') {
                        acts.drop(event.id);
                        sync();
                        void acts.fail(faultLine(event.fault), event.message, event.fault);
                    }
                    else {
                        // cancelled while it still waited: the blank sheet goes back into the box; dropped: silent
                        if (event.result === 'cancelled' && task && task.phase !== 'generating')
                            speech.say('unqueued');
                        acts.drop(event.id);
                        sync();
                    }
                }
                break;
            case 'history':
                if (!event.saved && event.message)
                    speech.say(null, event.message);
                break;
            case 'auto':
                autoWaiting = Math.max(0, event.waiting);
                m.st.box.queued = queued + autoWaiting;
                hooks.wake();
                break;
            case 'ui':
                if (event.action === 'menu-open')
                    acts.menu(true);
                else if (event.action === 'menu-close')
                    acts.menu(false);
                hooks.wake();
                break;
            case 'stop':
                stopped = true;
                hooks.stop();
                break;
        }
    };
    const off = onPetEvent(handle);
    signal.addEventListener('abort', () => { stopped = true; off(); stopQueue(); }, { once: true });
}
