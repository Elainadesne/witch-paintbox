export interface SifangFloor {
  saveId: string;
  volume: string | null;
  floor: number;
  node: string;
  role: 'user' | 'assistant';
  name: string;
  raw: string;
  text: string;
  paras: Array<{ i: number; text: string }>;
  status: string;
  busy: boolean;
  version: number;
  count: number;
}

export interface SifangSave { id: string; name: string; volume: string | null }
export interface SifangMarkerView {
  id: string;
  start: number;
  end: number;
  summary: string;
  state?: 'idle' | 'queued' | 'generating';
  status?: string;
  blob?: Blob | null;
  /** The picture keeps its place in the frame but stays hidden (the desktop pet is flying it in). */
  veiled?: boolean;
}
/** A host frame's box in the plugin window's coordinates, with the band of the story that shows. */
export interface SifangMarkerRect {
  left: number;
  top: number;
  width: number;
  height: number;
  view?: { left: number; top: number; right: number; bottom: number };
}
export interface SifangMarkerEvent {
  action: 'generate' | 'open' | 'cancel';
  saveId: string;
  node: string;
  marker: Pick<SifangMarkerView, 'id' | 'start' | 'end' | 'summary'>;
  raw: string;
}

interface SifangHost {
  apiVersion: number;
  capabilities: readonly string[];
  game: {
    floor(floor?: number): Promise<SifangFloor | null>;
    floors(): Promise<Array<Pick<SifangFloor, 'floor' | 'node' | 'role'>>>;
    save(): Promise<SifangSave | null>;
    replaceText(options: { saveId: string; node: string; volume: string | null; expectedRaw: string; raw: string }): Promise<SifangFloor>;
  };
  ui: {
    toast(text: string, kind?: string): Promise<unknown>;
    windowViewport?(enabled: boolean): Promise<void>;
    imageMarkers(options: { saveId: string; node: string; expectedRaw: string; markers: SifangMarkerView[] }): Promise<unknown>;
    imageMarker(options: { saveId: string; node: string; id: string } & Pick<SifangMarkerView, 'state' | 'status' | 'blob' | 'veiled'>): Promise<unknown>;
    /** Optional (capability native-image-marker-rect). */
    imageMarkerRect?(options: { saveId: string; node: string; id: string }): Promise<SifangMarkerRect | null>;
  };
  on(event: 'image-marker', handler: (payload: SifangMarkerEvent) => unknown): () => void;
  on(event: string, handler: (payload: unknown) => unknown): () => void;
}

// The host getter binds ownership from the plugin's module stack. Read it once,
// before callbacks run, and never resolve it through a hidden chat mirror.
const nativeEnvironment = 'Sifang' in globalThis;
export const sifangHost = (globalThis as typeof globalThis & { Sifang?: SifangHost }).Sifang;
export function isSifangEnvironment(): boolean { return nativeEnvironment; }

/** Request the browser viewport before mounting fixed-position UI in the native room. */
export async function bindSifangWindowViewport(signal: AbortSignal): Promise<void> {
  const host = sifangHost;
  if (signal.aborted || !host?.capabilities.includes('native-window-viewport') || !host.ui.windowViewport) return;
  const setViewport = host.ui.windowViewport.bind(host.ui);
  await setViewport(true);
  const release = () => { void setViewport(false).catch(() => { /* The host also releases it when the room stops. */ }); };
  if (signal.aborted) release();
  else signal.addEventListener('abort', release, { once: true });
}

export function requireSifangHost(): SifangHost {
  const host = sifangHost;
  if (!host || host.apiVersion !== 1
    || !['native-game', 'native-events', 'native-text-write', 'native-image-markers'].every(name => host.capabilities?.includes(name))
    || typeof host.game?.floor !== 'function' || typeof host.game.floors !== 'function'
    || typeof host.game.save !== 'function' || typeof host.game.replaceText !== 'function'
    || typeof host.ui?.imageMarkers !== 'function' || typeof host.ui.imageMarker !== 'function'
    || typeof host.on !== 'function') {
    throw new Error('独立前端与魔女画匣的接口版本不匹配，请更新支持正文写回和原位配图的独立前端。');
  }
  return host;
}
