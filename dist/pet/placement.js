import { clamp } from './state.js';
import { R } from './tia.js';
const NARROW = 700;
export function measureView() {
    const w = window.innerWidth, h = window.innerHeight, narrow = w < NARROW;
    let floor = h - 16;
    const r = document.getElementById('send_form')?.getBoundingClientRect();
    // on a phone the top of the tavern's input bar
    if (narrow)
        floor = r && r.top > h * 0.5 ? r.top - 2 : h - 74;
    const form = !narrow && r && r.width > 0 && r.top > h * 0.5 && r.bottom > h * 0.75 ? { left: r.left, right: r.right } : undefined;
    return { w, h, floor, narrow, dpr: window.devicePixelRatio || 1, ...(form ? { form } : {}) };
}
export function validSpot(spot) {
    const s = spot;
    return !!s && (s.place === 'floor' || s.place === 'side') && (s.edge === 'left' || s.edge === 'right')
        && typeof s.at === 'number' && Number.isFinite(s.at) && s.at >= 0 && s.at <= 1;
}
export class Places {
    m;
    changed;
    placement;
    /** The keyboard is up on a phone: she ducks behind the input bar. */
    keyboard = false;
    keyboardTimer = 0;
    constructor(m, placement, changed, signal) {
        this.m = m;
        this.changed = changed;
        this.placement = clean(placement);
        const measure = () => this.measure();
        window.addEventListener('resize', measure, { signal });
        window.visualViewport?.addEventListener('resize', measure, { signal });
        const form = document.getElementById('send_form');
        if (form && typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(measure);
            observer.observe(form);
            signal.addEventListener('abort', () => observer.disconnect(), { once: true });
        }
        const focus = () => this.checkKeyboard();
        document.addEventListener('focusin', focus, { capture: true, signal });
        document.addEventListener('focusout', () => setTimeout(focus, 0), { capture: true, signal });
        signal.addEventListener('abort', () => clearTimeout(this.keyboardTimer), { once: true });
    }
    get layout() { return this.m.view.narrow ? 'narrow' : 'wide'; }
    measure() {
        const m = this.m, st = m.st, before = m.view;
        const view = measureView();
        m.view = view;
        this.checkKeyboard();
        if (before.narrow !== view.narrow) {
            this.restore();
            this.changed();
            return;
        }
        // the same layout: she keeps her spot on the new page
        if (st.mode === 'side' && st.side) {
            const spot = this.placement[this.layout];
            st.side.y = m.sideY(spot?.place === 'side' ? spot.at * view.h : st.side.y);
        }
        else if (st.mode === 'idle' && !st.hop && !st.tucked) {
            // (with no spot of her own she is at home, which keeps clear of the input bar wherever it now lies)
            const spot = this.placement[this.layout];
            st.P = spot?.place === 'floor' ? [spot.at * view.w, view.floor] : spot ? [st.P[0] * view.w / Math.max(1, before.w), view.floor] : m.home();
        }
        if (st.away)
            st.boxAt = clamp(st.boxAt * view.w / Math.max(1, before.w), m.smallWidth(), view.w - m.smallWidth());
        this.changed();
    }
    checkKeyboard() {
        // (by the visible viewport only: the send box keeps its focus when the keyboard is put away, and the tavern focuses
        // it by itself when a chat opens)
        const m = this.m, vv = window.visualViewport;
        const up = m.view.narrow && !!vv && vv.height < window.innerHeight - 120;
        if (up === this.keyboard)
            return;
        this.keyboard = up;
        clearTimeout(this.keyboardTimer);
        // (down behind the input bar's edge at once, back up a moment after it closes)
        if (up)
            m.st.duckTo = 1;
        else
            this.keyboardTimer = window.setTimeout(() => { if (!this.keyboard) {
                m.st.duckTo = 0;
                this.changed();
            } }, 600);
        this.changed();
    }
    /** Puts her at this layout's spot, or nearest the old ball's corner, or home. */
    restore(initial = null) {
        const spot = this.placement[this.layout];
        if (spot)
            this.apply(spot);
        else if (initial)
            this.apply(this.nearest(initial));
        else
            this.home();
    }
    home() {
        const m = this.m, st = m.st;
        reset(m);
        st.onLeft = false;
        st.P = m.home();
        // on a phone the edge is where she rests
        if (m.view.narrow) {
            st.tucked = true;
            st.tk = 1;
            st.P = m.tuckP();
            st.rot = 0.03;
        }
        this.boxNear();
    }
    apply(spot) {
        const m = this.m, st = m.st;
        reset(m);
        if (spot.place === 'side') {
            st.mode = 'side';
            st.side = { dir: spot.edge === 'left' ? 'L' : 'R', y: m.sideY(spot.at * m.view.h) };
            st.onLeft = spot.edge === 'left';
            st.gone = 1;
            st.goneTo = 0;
            st.peek = 0.4;
            st.rot = m.sideBase();
            st.piv = [456, 628];
        }
        else {
            st.onLeft = spot.edge === 'left';
            st.P = [clamp(spot.at, 0, 1) * m.view.w, m.view.floor];
        }
        this.boxNear();
    }
    // the old ball's corner: the floor at its x, or a side when it is near an edge (low on the right is her corner)
    nearest(position) {
        const m = this.m, f = m.fig(), W = m.view.w, H = m.view.h;
        const x = position.x + 26, y = position.y + 26;
        const right = x > W - f * 0.45, left = x < f * 0.45, low = y > m.view.floor - f * 0.6;
        if ((right && !low) || left)
            return { place: 'side', edge: right ? 'right' : 'left', at: clamp(y / H, 0, 1) };
        return { place: 'floor', edge: x < W / 2 ? 'left' : 'right', at: clamp(x / W, 0, 1) };
    }
    /** Where she is now, as a spot. */
    current() {
        const m = this.m, st = m.st;
        if (st.mode === 'side' && st.side)
            return { place: 'side', edge: st.side.dir === 'L' ? 'left' : 'right', at: clamp(st.side.y / m.view.h, 0, 1) };
        if (st.mode !== 'idle')
            return null;
        const x = st.away ? st.boxAt + (st.onLeft ? -1 : 1) * m.fig() * 0.68 : m.toScreen(...R.feet)[0];
        return { place: 'floor', edge: st.onLeft ? 'left' : 'right', at: clamp(x / m.view.w, 0, 1) };
    }
    /** She settled where the player put her: remember it for this layout. */
    remember() {
        const spot = this.current();
        if (!spot)
            return null;
        this.placement = { ...this.placement, [this.layout]: spot };
        return { ...this.placement };
    }
    forget() { this.placement = {}; }
    set(placement) { this.placement = clean(placement); }
    /** The box straight to its place beside her (no trailing in from the corner at start). */
    boxNear() {
        const m = this.m, B = m.st.box;
        B.cx = -1;
        B.vx = B.vy = 0;
        if (m.st.away)
            m.st.boxAt = m.st.P[0] - (m.st.onLeft ? -1 : 1) * m.fig() * 0.68;
    }
}
function reset(m) {
    const st = m.st;
    if (st.hop) {
        st.hop.res();
        st.hop = null;
    }
    st.mode = 'idle';
    st.side = null;
    st.spot = null;
    st.dive = null;
    st.tucked = false;
    st.tk = 0;
    st.peek = 0;
    st.gone = st.goneTo = 0;
    st.piv = [...R.feet];
    st.rot = 0;
    st.rotV = 0;
    st.sq = 1;
    st.sqV = 0;
    st.vel = [0, 0];
}
function clean(placement) {
    const out = {};
    if (placement && validSpot(placement.wide))
        out.wide = { ...placement.wide };
    if (placement && validSpot(placement.narrow))
        out.narrow = { ...placement.narrow };
    return out;
}
/** The box's top-left corner when it has come to rest by her (what the old ball's position meant). */
export function restingCorner(m) {
    const [cx, cy] = m.boxTarget();
    const F = m.box.frame(cx, cy, m.boxWidth());
    const r = m.box.rect(F);
    return { x: Math.round(r.x), y: Math.round(r.y) };
}
