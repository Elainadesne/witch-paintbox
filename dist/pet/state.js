export const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const wind = (t, a, b) => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.3) * 0.4;
const spring = (k, d) => ({ x: 0, v: 0, k, d });
export function step(s, target, dt) { const a = s.k * (target - s.x) - s.d * s.v; s.v += a * dt; s.x += s.v * dt; }
export function springs() {
    return {
        head: spring(60, 11), hx: spring(50, 12), hat: spring(70, 6), tip: spring(45, 4.5), ah: spring(90, 5),
        bL: spring(32, 3.2), bR: spring(32, 3.2), hairL: spring(18, 3), hairR: spring(18, 3), armL: spring(40, 7), armR: spring(40, 7),
        skirt: spring(26, 3.6), cup: spring(30, 2.6), still: spring(1, 1),
    };
}
export const FACES = ['base', 'focus', 'happy', 'dismay', 'talk'];
export function createState() {
    return {
        t: 0,
        // where she stands: the screen point of the pivot (feet unless held), her rotation and squash
        piv: [456, 1232], P: [0, 0], rot: 0, rotV: 0, sq: 1, sqV: 0, vel: [0, 0], mode: 'idle',
        lookOn: 0, ptr: [-1, -1], ptrPrev: [-1, -1], ptrV: [0, 0], ptrA: [0, 0],
        expr: { base: 1, focus: 0, happy: 0, dismay: 0, talk: 0, blink: 0 }, want: 'base', blinkAt: 2.2, blinkT: -1, nod: 0,
        // (the box is a book: ang is its cover's angle on the hinge in degrees, av how fast it turns; open is ang as a share
        // of the cover's rest angle; queued counts the blank sheets clipped behind the picture under way; small is how far
        // it has shrunk to the old ball's size while she rests in it, crack how far it opens then while a picture is drawn)
        box: { open: 0, want: 0, ang: 0, av: 0, pop: 0, shake: 0, zoom: 0, cx: -1, cy: -1, vx: 0, vy: 0, queued: 0, fade: 1, small: 0, smallTo: 0, crack: 0, glow: 0, show: 1, showTo: 1 },
        ahDroop: 0,
        paint: null, motes: [], smoke: [], sparks: [], fly: null, menu: false,
        // with nothing to do she curls up in the screen's right edge with the box in her arms and dozes: tk eases her into
        // that pose, peek leans her out to look when the pointer comes close, doze closes her eyes, idle counts the quiet
        // seconds; hop is a jump under way
        tucked: false, tk: 0, peek: 0, doze: 0, idle: 0, hop: null, toEdge: false, asleep: false, wakeT: 0,
        // let go by the screen's side she hides in it: side is where (dir R or L, y the height of her middle), gone slides
        // her out of sight as she comes and goes, spot is the side she goes back to after a piece of work, dive her dart
        // into it when let go, onLeft keeps her on the page's left after the left side; taken out of the side she swings
        // down from her quarter turn (rotMax lets the swing start there)
        side: null, spot: null, gone: 0, goneTo: 0, dive: null,
        onLeft: false, rotMax: 0.75,
        casting: false, failing: false, reading: false,
        // her working look while she paints (the brim's right side folded up, pinned with a brush): k is its share, a the
        // flap's angle from up (rad, clockwise), v how fast it turns, bend how far its far end trails, t how long it has
        // been on its way down
        brim: { up: false, k: 0, a: 0, v: 0, bend: 0, t: 0 },
        // a fault's act on the 2D layer, and nap: the seconds she has left dozing over the easel (it took too long); gaze is
        // where she watches it go wrong, tilt her head's puzzled tilt; waitFrom (performance.now ms) is when the picture
        // under way began, so a long wait can send her to sleep over the easel (easel: she is, or is going)
        fault: null, nap: 0, gaze: null, tilt: 0, waitFrom: 0, easel: false,
        // (new in the plugin) her own size and opacity, for climbing into the paintbox and the still mode's fades; away: she
        // is in the paintbox; duck: on a phone she has ducked behind the input bar for the keyboard; inFront draws her over
        // the paintbox while she climbs in or out of it
        shrink: 1, alpha: 1, alphaTo: 1, away: false, boxAt: 0, boxHold: null, duck: 0, duckTo: 0, inFront: false,
    };
}
