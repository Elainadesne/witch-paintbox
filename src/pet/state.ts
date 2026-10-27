import type { Tex } from './gl.js';

export type Vec = [number, number];

export const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const wind = (t: number, a: number, b: number) => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.3) * 0.4;

// springs for the loose parts: x is an angle (rad) or an offset (texture px)
export interface Spring { x: number; v: number; k: number; d: number }
const spring = (k: number, d: number): Spring => ({ x: 0, v: 0, k, d });
export function step(s: Spring, target: number, dt: number) { const a = s.k * (target - s.x) - s.d * s.v; s.v += a * dt; s.x += s.v * dt; }

export function springs() {
  return {
    head: spring(60, 11), hx: spring(50, 12), hat: spring(70, 6), tip: spring(45, 4.5), ah: spring(90, 5),
    bL: spring(32, 3.2), bR: spring(32, 3.2), hairL: spring(18, 3), hairR: spring(18, 3), armL: spring(40, 7), armR: spring(40, 7),
    skirt: spring(26, 3.6), cup: spring(30, 2.6), still: spring(1, 1),
  };
}
export type Springs = ReturnType<typeof springs>;
export type SpringName = keyof Springs;

export type Face = 'base' | 'focus' | 'happy' | 'dismay' | 'talk';
export const FACES: Face[] = ['base', 'focus', 'happy', 'dismay', 'talk'];

export interface SideSpot { dir: 'L' | 'R'; y: number }
export interface Hop { from: Vec; to: () => Vec; t: number; dur: number; lift: number; res: () => void; up: boolean; fade?: boolean }

/** A sheet on the easel: blank, washed while the picture is drawn, then the picture blooming in. */
export interface Sheet {
  id: string;
  aspect: number;
  tex: Tex | null;
  bitmap: ImageBitmap | null;
  reveal: number;
  wash: number;
  washing: boolean;
  emit: boolean;
  lifted: boolean;
  acc: number;
}

/** How a fault is acted out: a blank type block, a key that will not turn, the thread snapping, the pans running dry, a
 * nap over the easel, or the plain puff. */
export type FaultAct = 'blank' | 'key' | 'thread' | 'dry' | 'nap' | 'plain';
export interface FaultFx { act: FaultAct; t: number; at: Vec | null; cues: number }

export interface Mote { x: number; y: number; x0: number; y0: number; tx: number; ty: number; t: number; life: number; r: number; c: string; sw: number }
export interface Puff { x: number; y: number; vx: number; vy: number; r: number; t: number; life: number; c: string; grow?: number }
export interface Spark { x: number; y: number; r: number; a: number; t: number; life: number }
export interface Box4 { x: number; y: number; w: number; h: number }
export interface Flight {
  img: ImageBitmap;
  t: number;
  hold: number;
  dur: number;
  from: Box4;
  to: () => Box4;
  landed: boolean;
  /** Fades out on the way (into the paintbox or off the chat's edge) instead of melting into a frame. */
  fade: boolean;
  near?: () => void;
  nearDone?: boolean;
  onLand: () => void;
}

export function createState() {
  return {
    t: 0,
    // where she stands: the screen point of the pivot (feet unless held), her rotation and squash
    piv: [456, 1232] as Vec, P: [0, 0] as Vec, rot: 0, rotV: 0, sq: 1, sqV: 0, vel: [0, 0] as Vec, mode: 'idle' as 'idle' | 'drag' | 'fall' | 'dive' | 'side',
    lookOn: 0, ptr: [-1, -1] as Vec, ptrPrev: [-1, -1] as Vec, ptrV: [0, 0] as Vec, ptrA: [0, 0] as Vec,
    expr: { base: 1, focus: 0, happy: 0, dismay: 0, talk: 0, blink: 0 }, want: 'base' as Face, blinkAt: 2.2, blinkT: -1, nod: 0,
    // (the box is a book: ang is its cover's angle on the hinge in degrees, av how fast it turns; open is ang as a share
    // of the cover's rest angle; queued counts the blank sheets clipped behind the picture under way; small is how far
    // it has shrunk to the old ball's size while she rests in it, crack how far it opens then while a picture is drawn)
    box: { open: 0, want: 0, ang: 0, av: 0, pop: 0, shake: 0, zoom: 0, cx: -1, cy: -1, vx: 0, vy: 0, queued: 0, fade: 1, small: 0, smallTo: 0, crack: 0, glow: 0, show: 1, showTo: 1 },
    ahDroop: 0,
    paint: null as Sheet | null, motes: [] as Mote[], smoke: [] as Puff[], sparks: [] as Spark[], fly: null as Flight | null, menu: false,
    // with nothing to do she curls up in the screen's right edge with the box in her arms and dozes: tk eases her into
    // that pose, peek leans her out to look when the pointer comes close, doze closes her eyes, idle counts the quiet
    // seconds; hop is a jump under way
    tucked: false, tk: 0, peek: 0, doze: 0, idle: 0, hop: null as Hop | null, toEdge: false, asleep: false, wakeT: 0,
    // let go by the screen's side she hides in it: side is where (dir R or L, y the height of her middle), gone slides
    // her out of sight as she comes and goes, spot is the side she goes back to after a piece of work, dive her dart
    // into it when let go, onLeft keeps her on the page's left after the left side; taken out of the side she swings
    // down from her quarter turn (rotMax lets the swing start there)
    side: null as SideSpot | null, spot: null as SideSpot | null, gone: 0, goneTo: 0, dive: null as { t: number; from: Vec; spot: SideSpot } | null,
    onLeft: false, rotMax: 0.75,
    casting: false, failing: false, reading: false,
    // her working look while she paints (the brim's right side folded up, pinned with a brush): k is its share, a the
    // flap's angle from up (rad, clockwise), v how fast it turns, bend how far its far end trails, t how long it has
    // been on its way down
    brim: { up: false, k: 0, a: 0, v: 0, bend: 0, t: 0 },
    // a fault's act on the 2D layer, and nap: the seconds she has left dozing over the easel (it took too long); gaze is
    // where she watches it go wrong, tilt her head's puzzled tilt; waitFrom (performance.now ms) is when the picture
    // under way began, so a long wait can send her to sleep over the easel (easel: she is, or is going)
    fault: null as FaultFx | null, nap: 0, gaze: null as Vec | null, tilt: 0, waitFrom: 0, easel: false,
    // her head under a hand: pat is how far she has given in to it (eyes narrowed), patT how long this bout has gone
    // on, shyT the seconds after she ducked away when she will not take it again
    pat: 0, patT: 0, shyT: 0,
    // (new in the plugin) her own size and opacity, for climbing into the paintbox and the still mode's fades; away: she
    // is in the paintbox; duck: on a phone she has ducked behind the input bar for the keyboard; inFront draws her over
    // the paintbox while she climbs in or out of it
    shrink: 1, alpha: 1, alphaTo: 1, away: false, boxAt: 0, boxHold: null as Vec | null, duck: 0, duckTo: 0, inFront: false,
  };
}
export type State = ReturnType<typeof createState>;

/** The page as she sees it, measured on resize only. */
export interface View {
  w: number;
  h: number;
  /** The line she stands on: the page's foot, or on a phone the top of the tavern's input bar. */
  floor: number;
  narrow: boolean;
  dpr: number;
  /** On a wide page, the tavern's input bar where it runs along the foot (its send button is not to be stood on). */
  form?: { left: number; right: number };
}
