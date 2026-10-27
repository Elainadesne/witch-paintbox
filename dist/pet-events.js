const listeners = new Set();
export function onPetEvent(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function emitPetEvent(event) {
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch { /* A pet must never interrupt generation, saving or rendering. */ }
    }
}
/** Same id style as image-config.ts:10-12. */
export function petTaskId() {
    return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
/** Lets only the first 'end' of a task through. */
export function petEnd() {
    let ended = false;
    return event => { if (!ended) {
        ended = true;
        emitPetEvent(event);
    } };
}
export function withFault(error, fault) {
    return Object.assign(error, { fault });
}
export function petFault(error) {
    const fault = error?.fault;
    return typeof fault === 'string' ? fault : 'unknown';
}
