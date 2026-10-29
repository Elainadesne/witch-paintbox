/**
 * Counts in-flight write requests (anything but GET/HEAD) made through fetch or XHR, so automatic work can wait
 * for follow-up model calls such as character-card variable updates. Streamed bodies count until headers arrive;
 * callers pair this with host events for the rest.
 */
const STALE_AFTER = 120_000;
const active = new Set<number>();
let lastActivity = 0;
let installed = false;

function begin(): () => void {
  const token = Date.now() + Math.random();
  active.add(token);
  lastActivity = Date.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active.delete(token);
    lastActivity = Date.now();
  };
}

function tracked(method: string | undefined): boolean {
  const name = (method ?? 'GET').toUpperCase();
  return name !== 'GET' && name !== 'HEAD';
}

export function installRequestActivity(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = nativeFetch.call(window, input, init);
    if (tracked(init?.method ?? (input instanceof Request ? input.method : undefined))) {
      const end = begin();
      response.then(end, end);
    }
    return response;
  };
  const prototype = XMLHttpRequest.prototype;
  const open = prototype.open, send = prototype.send;
  const methods = new WeakMap<XMLHttpRequest, string>();
  prototype.open = function (this: XMLHttpRequest, method: string, ...rest: unknown[]) {
    methods.set(this, String(method));
    return (open as (...args: unknown[]) => void).call(this, method, ...rest);
  } as typeof prototype.open;
  prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (tracked(methods.get(this))) this.addEventListener('loadend', begin(), { once: true });
    return send.call(this, body);
  };
}

/** Milliseconds since the last tracked request started or finished; 0 while one is still running. */
export function requestQuietFor(now = Date.now()): number {
  // Tokens start at their creation time, so a request older than STALE_AFTER no longer blocks.
  for (const token of active) if (now - token < STALE_AFTER) return 0;
  return now - lastActivity;
}
