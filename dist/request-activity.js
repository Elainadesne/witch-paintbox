/**
 * Counts in-flight write requests (anything but GET/HEAD) made through fetch or XHR, so automatic work can wait
 * for follow-up model calls such as character-card variable updates. Streamed bodies count until headers arrive;
 * callers pair this with host events for the rest.
 */
const STALE_AFTER = 120_000;
const active = new Set();
let lastActivity = 0;
let installed = false;
function begin() {
    const token = Date.now() + Math.random();
    active.add(token);
    lastActivity = Date.now();
    let ended = false;
    return () => {
        if (ended)
            return;
        ended = true;
        active.delete(token);
        lastActivity = Date.now();
    };
}
function tracked(method) {
    const name = (method ?? 'GET').toUpperCase();
    return name !== 'GET' && name !== 'HEAD';
}
export function installRequestActivity() {
    if (installed)
        return;
    installed = true;
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
        const response = nativeFetch.call(window, input, init);
        if (tracked(init?.method ?? (input instanceof Request ? input.method : undefined))) {
            const end = begin();
            response.then(end, end);
        }
        return response;
    };
    const prototype = XMLHttpRequest.prototype;
    const open = prototype.open, send = prototype.send;
    const methods = new WeakMap();
    prototype.open = function (method, ...rest) {
        methods.set(this, String(method));
        return open.call(this, method, ...rest);
    };
    prototype.send = function (body) {
        if (tracked(methods.get(this)))
            this.addEventListener('loadend', begin(), { once: true });
        return send.call(this, body);
    };
}
/** Milliseconds since the last tracked request started or finished; 0 while one is still running. */
export function requestQuietFor(now = Date.now()) {
    // Tokens start at their creation time, so a request older than STALE_AFTER no longer blocks.
    for (const token of active)
        if (now - token < STALE_AFTER)
            return 0;
    return now - lastActivity;
}
