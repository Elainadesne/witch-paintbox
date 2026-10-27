// How she moves: the state, the springs, one simulation step (at most 1/60 s), and a clock of her own for the acts
// (it runs with the frame loop, so everything waits while she is not drawn).
import { SHUT_WIDTH, type BoxFrame, type Paintbox } from './box.js';
import { BRIM_DOWN, R, SIDE, TH, type Rig } from './tia.js';
import { clamp, createState, FACES, lerp, springs, step, wind, type Box4, type Face, type SideSpot, type Vec, type View } from './state.js';

export interface MotionHooks {
  tuckIn(): void;
  backToSide(): void;
  enterSide(spot: SideSpot): void;
  /** Down on the floor after a fall. */
  landed(): void;
}

interface Waiter { done(): boolean; resolve(): void; each?(): void }

/** A picture still not in after this long (s) and she nods off over the easel (the plugin gives up at five minutes). */
export const LONG_WAIT = 60;

export class Motion {
  readonly st = createState();
  readonly S = springs();
  /** Reduced motion or 动效 off: only breathing and blinking. */
  still = false;
  /** The rect of what she reads (cached, refreshed twice a second while she reads). */
  readAt: Box4 | null = null;
  noteOn = false;
  /** The still mode's paintbox: the open state's share in its cross-fade. */
  fadeOpen = 0;
  private waiters: Waiter[] = [];

  constructor(readonly rig: Rig, readonly box: Paintbox, public view: View, public hooks: MotionHooks) {}

  fig() { return this.view.narrow ? 160 : 296; }         // her texture's height on screen (CSS px); she is 89% of it
  scale() { return this.fig() / TH * this.st.shrink; }
  // quiet seconds before she curls up in her corner
  idleSeconds() { return this.view.narrow ? 3 : 15; }
  // (on the left of the page after she hid on the left)
  home(): Vec { const st = this.st, n = this.view.narrow; return [st.onLeft ? (n ? 62 : 150) : this.view.w - (n ? 62 : 150), this.view.floor]; }
  // in the edge: her feet at it, so it cuts her down the middle (asleep, half her face shows); awake she leans out
  tuckP(): Vec { return [this.view.w - this.fig() * lerp(0.07, 0.12, this.st.peek), this.view.floor]; }
  // her middle, for a let-go at this height: the brim of her hat stays on the page, her box above the floor
  sideY(y: number) { return clamp(y, this.fig() * 0.36, this.view.floor - this.fig() * 0.74); }
  sideBase() { return this.st.side?.dir === 'L' ? Math.PI / 2 : -Math.PI / 2; }

  // texture px -> screen, for the current pose
  toScreen(x: number, y: number): Vec {
    const st = this.st, s = this.scale(), c = Math.cos(st.rot), n = Math.sin(st.rot);
    const lx = (x - st.piv[0]) * s * (2 - st.sq) ** 0.5, ly = (y - st.piv[1]) * s * st.sq;
    return [st.P[0] + lx * c - ly * n, st.P[1] + lx * n + ly * c];
  }
  /** A point on her head (texture px) -> screen: with the head's turn and sink and her breath, as the mesh has it. */
  headToScreen(x: number, y: number): Vec {
    const S = this.S, n = R.neck, sn = Math.sin(S.head.x), co = Math.cos(S.head.x), dx = x - n[0], dy = y - n[1];
    const br = (Math.sin(this.st.t * (Math.PI * 2 / 3.8)) + 1) * 0.5;
    return this.toScreen(n[0] + dx * co - dy * sn, n[1] + dx * sn + dy * co + S.hx.x * 0.6 - 2.6 * br);
  }
  toTex(X: number, Y: number): Vec {
    const st = this.st, s = this.scale(), c = Math.cos(-st.rot), n = Math.sin(-st.rot);
    const dx = X - st.P[0], dy = Y - st.P[1];
    const lx = dx * c - dy * n, ly = dx * n + dy * c;
    return [st.piv[0] + lx / (s * (2 - st.sq) ** 0.5), st.piv[1] + ly / (s * st.sq)];
  }
  /** Her texture px -> screen as a CSS matrix (a, b, c, d, e, f), for the hit parts. */
  matrix(): [number, number, number, number, number, number] {
    const st = this.st, s = this.scale(), c = Math.cos(st.rot), n = Math.sin(st.rot);
    const sx = s * (2 - st.sq) ** 0.5, sy = s * st.sq;
    const a = c * sx, b = n * sx, cc = -n * sy, d = c * sy;
    return [a, b, cc, d, st.P[0] - a * st.piv[0] - cc * st.piv[1], st.P[1] - b * st.piv[0] - d * st.piv[1]];
  }
  /** Her shown at all (not in the paintbox, not ducked or slid out of sight). */
  visible() { const st = this.st; return !st.away && st.alpha > 0.04 && st.duck < 0.9 && !(st.mode === 'side' && st.gone > 0.9); }
  hit(X: number, Y: number) {
    const st = this.st;
    if (!this.visible()) return false;
    // (in the side, only what is out of the edge)
    if (st.mode === 'side' && st.side && (st.side.dir === 'R' ? X > this.view.w : X < 0)) return false;
    const [x, y] = this.toTex(X, Y);
    return this.rig.opaque(x, y);
  }

  // the box beside her: it floats where she keeps it and trails after her when she is carried off (a familiar on a
  // spring); open, it stands as an easel, and while she paints it comes up a little closer to be seen; while she rests
  // in it, it sits small on the floor
  boxTarget(): Vec {
    const st = this.st, f = this.fig(), view = this.view;
    // (it holds still while she climbs into it or out of it)
    if (st.boxHold) return st.boxHold;
    if (st.away || st.box.smallTo > 0) return [st.boxAt, view.floor - this.smallHeight() / 2];
    // (the box keeps to the page's middle side of her)
    const away = st.onLeft ? -1 : 1;
    if (st.mode === 'drag' || st.mode === 'fall' || st.mode === 'dive') { const w = this.toScreen(...R.waist); return [w[0] - away * f * 0.5, w[1] + f * 0.12]; }
    if (st.mode === 'side' && st.side) {
      // in the side it hides under her with a corner out; open, it comes out to stand by the edge
      const right = st.side.dir === 'R', ex = right ? view.w : 0, open = st.menu || st.box.want > 0;
      const d = (open ? 0.34 : lerp(0.05, 0.12, st.peek)) * (1 - st.gone) - 0.2 * st.gone;
      return [ex - (right ? 1 : -1) * f * d, Math.min(st.side.y + f * 0.5, view.floor - f * 0.22)];
    }
    const by: Vec = [st.P[0] - away * f * (0.68 + 0.1 * st.box.zoom), st.P[1] - f * (0.26 + 0.1 * st.box.zoom)];
    if (st.tk < 0.001) return by;
    // in the edge she holds it on her lap, in front of her left hand
    const lap = this.toScreen(...R.lap);
    return [lerp(by[0], lap[0], st.tk), lerp(by[1], lap[1], st.tk)];
  }
  smallWidth() { return this.view.narrow ? 52 : 64; }
  smallHeight() { return this.box.heightFor(this.smallWidth()); }
  boxWidth() {
    const st = this.st, f = this.fig();
    return lerp(f * SHUT_WIDTH * (1 + 0.3 * st.box.zoom) * (1 - 0.22 * st.tk), this.smallWidth(), st.box.small);
  }
  // where the book's texture frame lies on the screen: the shut book's middle is the box's point; it bobs, pops and
  // shakes, comes a little bigger while she paints, and is smaller in her arms in the edge
  boxFrame(): BoxFrame {
    const st = this.st, f = this.fig(), B = st.box;
    const bob = this.still ? 0 : (Math.sin(st.t * 1.7) * f * 0.012 * (1 - st.tk) - B.pop * f * 0.05) * (1 - B.small);
    const shake = this.still ? 0 : B.shake ? Math.sin(st.t * 70) * 2.5 * B.shake : 0;
    return this.box.frame(B.cx, B.cy, this.boxWidth(), shake, bob);
  }
  boxRect(): Box4 { return this.box.rect(this.boxFrame()); }
  boxShown() { return this.st.box.show > 0.04 && this.st.duck < 0.9; }
  boxHit(X: number, Y: number) {
    if (!this.boxShown()) return false;
    const b = this.box.hitRect(this.boxFrame(), this.st.box.open);
    return X >= b.x && X <= b.x + b.w && Y >= b.y && Y <= b.y + b.h;
  }
  want(face: Face) { this.st.want = face; }

  // ---- her clock ---------------------------------------------------------------------------------------------------
  until(done: () => boolean): Promise<void> {
    return new Promise(resolve => { if (done()) resolve(); else this.waiters.push({ done, resolve }); });
  }
  wait(seconds: number): Promise<void> { const at = this.st.t + seconds; return this.until(() => this.st.t >= at); }
  later(seconds: number, fn: () => void) { void this.wait(seconds).then(fn); }
  tween(seconds: number, f: (k: number) => void): Promise<void> {
    const t0 = this.st.t;
    return new Promise(resolve => {
      const each = () => f(Math.min(1, (this.st.t - t0) / seconds));
      this.waiters.push({ done: () => this.st.t - t0 >= seconds, resolve: () => { f(1); resolve(); }, each });
    });
  }
  private tick() {
    if (!this.waiters.length) return;
    const ready: Waiter[] = [];
    this.waiters = this.waiters.filter(w => { w.each?.(); if (w.done()) { ready.push(w); return false; } return true; });
    for (const w of ready) w.resolve();
  }

  // ---- one step ----------------------------------------------------------------------------------------------------
  update(dt: number) {
    const st = this.st, S = this.S, view = this.view, still = this.still;
    st.t += dt;
    const t = st.t;
    // pointer speed and acceleration (for the dangling), smoothed: pointer events come unevenly
    if (st.ptrPrev[0] >= 0) {
      const vx = (st.ptr[0] - st.ptrPrev[0]) / dt, vy = (st.ptr[1] - st.ptrPrev[1]) / dt;
      const nvx = st.ptrV[0] + (vx - st.ptrV[0]) * Math.min(1, dt * 18), nvy = st.ptrV[1] + (vy - st.ptrV[1]) * Math.min(1, dt * 18);
      const ax = (nvx - st.ptrV[0]) / dt;
      st.ptrA = [st.ptrA[0] + (ax - st.ptrA[0]) * Math.min(1, dt * 14), 0];
      st.ptrV = [nvx, nvy];
    }
    st.ptrPrev = [st.ptr[0], st.ptr[1]];
    let held = 0;
    if (st.mode === 'drag') {
      held = 1;
      st.P = [st.ptr[0], st.ptr[1]];
      if (still) { st.rot = 0; st.rotV = 0; }
      else {
        // a pendulum hung from the grab point: the hand's acceleration swings her back, gravity brings her round;
        // taken below the waist she is only carried, with a small sway
        const Ly = (R.waist[1] - st.piv[1]) * this.scale(), L = Math.max(40, Math.abs(Ly));
        const ax = clamp(st.ptrA[0], -9000, 9000);
        const acc = Ly > 30
          ? -(2600 / L) * Math.sin(st.rot) - 3.4 * st.rotV + (ax / L) * Math.cos(st.rot)
          : -70 * st.rot - 10 * st.rotV + ax / 5000;
        // (taken out of the side she swings down from her quarter turn; the limit closes in behind the swing)
        st.rotMax = Math.max(0.75, Math.min(st.rotMax, Math.abs(st.rot) + 0.05) - dt * 0.6);
        st.rotV = clamp(st.rotV + acc * dt, -9, 9); st.rot = clamp(st.rot + st.rotV * dt, -st.rotMax, st.rotMax);
      }
    } else if (st.mode === 'fall') {
      st.vel[1] += 3800 * dt;
      st.P = [st.P[0] + st.vel[0] * dt, st.P[1] + st.vel[1] * dt];
      st.vel[0] *= 0.985;
      const r = { x: st.rot, v: st.rotV, k: 30, d: 6 };
      step(r, 0, dt); st.rot = r.x; st.rotV = r.v;
      const floor = view.floor;
      if (st.P[1] >= floor) {
        st.P[1] = floor; st.mode = 'idle'; st.sqV = -Math.min(5.5, 1.2 + st.vel[1] / 900); st.vel = [0, 0];
        this.later(0.26, () => { if (st.want === 'dismay') this.want('base'); });
        if (st.toEdge) { st.toEdge = false; this.later(1.1, () => this.hooks.tuckIn()); }
        this.hooks.landed();
      }
    } else if (st.mode === 'dive' && st.dive) {
      // let go by the screen's side: she darts into it at that height
      const D = st.dive;
      D.t += dt;
      const k = still ? 1 : Math.min(1, D.t / 0.18), e = k * k * (3 - 2 * k), ex = D.spot.dir === 'R' ? view.w + this.fig() * 0.6 : -this.fig() * 0.6;
      st.P = [lerp(D.from[0], ex, e), lerp(D.from[1], D.spot.y, e)];
      if (D.t >= 0.18 || still) this.hooks.enterSide(D.spot);
    } else if (st.mode === 'side' && st.side) {
      // in the side: out to her forearms on the edge when the pointer comes near, in to her hat when it goes
      const right = st.side.dir === 'R';
      st.piv = [456, SIDE.edge];
      const row = lerp(lerp(SIDE.hide, SIDE.edge, st.peek), SIDE.gone, st.gone);
      const sh = (SIDE.edge - row) * this.scale();
      st.P = [right ? view.w + sh : -sh, st.side.y];
      const lean = this.sideBase() + (right ? 1 : -1) * st.doze * 0.04;
      if (still) { st.rot = this.sideBase(); st.rotV = 0; }
      else { st.rotV += (-40 * (st.rot - lean) - 8 * st.rotV) * dt; st.rot += st.rotV * dt; }
    } else {
      // standing: a jump under way (a crouch, up stretched, down squashed), or in the edge she keeps to it
      const h = st.hop;
      if (h) {
        h.t += dt;
        if (h.fade) {
          // (still: out of sight and back in at the new place)
          const k = Math.min(1, Math.max(0, h.t) / 0.3);
          st.alpha = k < 0.5 ? 1 - 2 * k : 2 * k - 1;
          st.P = k < 0.5 ? h.from : h.to();
          if (k >= 1) { st.hop = null; st.alpha = 1; h.res(); }
        } else if (h.t >= 0) {
          if (!h.up) { h.up = true; st.sqV += 4.2; }
          const k = Math.min(1, h.t / h.dur), e = k * k * (3 - 2 * k), to = h.to();
          st.P = [lerp(h.from[0], to[0], e), lerp(h.from[1], to[1], e) - Math.sin(k * Math.PI) * h.lift * this.fig()];
          if (k >= 1) { st.hop = null; st.sqV -= 3.2; h.res(); }
        }
      } else if (st.tucked) st.P = this.tuckP();
      // rotation and squash go home: upright, or in the edge leant on it asleep and leant out of it awake
      const lean = st.tk * lerp(0.04, -0.1, st.peek);
      if (still) { st.rot = lean; st.rotV = 0; }
      else { st.rotV += (-40 * (st.rot - lean) - 8 * st.rotV) * dt; st.rot += st.rotV * dt; }
    }
    if (still) { st.sq = 1; st.sqV = 0; }
    else {
      st.sqV += (-220 * (st.sq - 1) - 13 * st.sqV) * dt; st.sq += st.sqV * dt;
      st.sq = clamp(st.sq, 0.78, 1.18);
    }

    // where she looks: at the pointer when it is near, else a slow drift; a sleepy nod now and then
    const head = this.toScreen(464, 480);
    // (reading, she looks along the reply's lines instead)
    // (a fault's act: she watches it go wrong)
    const rd = st.reading ? this.readAt : null, gz = st.gaze;
    const at: Vec = rd ? [rd.x + rd.w * (0.5 + 0.4 * Math.sin(t * 1.3)), rd.y + rd.h * 0.5] : gz ?? st.ptr;
    const dx = at[0] - head[0], dy = at[1] - head[1];
    // (which way that is for her, turned as she is)
    const cl = Math.cos(-st.rot), sl = Math.sin(-st.rot), fx = dx * cl - dy * sl, fy = dx * sl + dy * cl;
    const near = rd || gz ? 1 : st.ptr[0] >= 0 && Math.hypot(dx, dy) < (view.narrow ? 260 : 620) ? 1 : 0;
    st.lookOn += (near * (1 - st.doze) - st.lookOn) * Math.min(1, dt * 3);
    // the edge: with the pointer close she leans out awake; quiet long enough near her corner she curls up in it, and
    // there she soon dozes off (put down elsewhere, she dozes where she stands, later)
    const close = st.ptr[0] >= 0 && Math.hypot(dx, dy) < (view.narrow ? 150 : 330);
    const side = st.mode === 'side';
    const busy = st.casting || st.reading || st.failing || st.menu || (st.mode !== 'idle' && !side) || !!st.hop || st.away;
    st.idle = busy || close || this.noteOn ? 0 : st.idle + dt;
    st.tk += ((st.tucked ? 1 : 0) - st.tk) * Math.min(1, dt * 4);
    const peekTo = still && (st.tucked || side) ? 0.55 : (st.tucked || side) && (close || st.menu) ? 1 : 0;
    st.peek = still ? peekTo : st.peek + (peekTo - st.peek) * Math.min(1, dt * (peekTo ? 5 : 2));
    st.gone += (st.goneTo - st.gone) * Math.min(1, dt * 9);
    st.duck += (st.duckTo - st.duck) * Math.min(1, dt * 9);
    if (still) { st.gone = st.goneTo; st.duck = st.duckTo; }
    if (!st.hop?.fade) st.alpha += Math.sign(st.alphaTo - st.alpha) * Math.min(Math.abs(st.alphaTo - st.alpha), dt / 0.15);
    // back to her side after a piece of work, once it is quiet
    const idleFor = this.idleSeconds();
    if (st.spot && st.mode === 'idle' && !st.tucked && !busy && st.idle > idleFor) this.hooks.backToSide();
    st.nap = Math.max(0, st.nap - dt);
    // (over the easel: a picture that will not come, or the timeout's nap)
    st.easel = st.nap > 0 || (st.waitFrom > 0 && !st.failing && performance.now() - st.waitFrom > LONG_WAIT * 1000);
    const sleepy = st.easel || st.idle > (st.tucked ? 1.5 : side ? 3 : idleFor + 20);
    if (sleepy && st.doze > 0.9) st.asleep = true;
    // woken with a start: the ahoge flicks, the hat jumps, her eyes fly open for a moment
    if (!sleepy && st.asleep) {
      st.asleep = false;
      if (!still) { S.ah.v -= 7; st.sqV += 1.6; S.hat.v -= 0.8; S.tip.v -= 3; }
      st.nod = 0;
      if (st.want === 'base') { this.want('focus'); st.wakeT = 1.2; }
    }
    if (st.wakeT > 0 && (st.wakeT -= dt) <= 0 && st.want === 'focus' && !st.reading && !st.casting && !st.failing) this.want('base');
    st.doze += ((sleepy ? 1 : 0) - st.doze) * Math.min(1, dt * (sleepy ? (st.nap > 0 ? 2.6 : st.easel ? 0.9 : 1.2) : 8));
    if (st.mode === 'idle' && !st.tucked && !st.spot && !busy && st.idle > idleFor && st.P[0] > view.w - this.fig() * 1.2) this.hooks.tuckIn();
    if (!still && st.doze > 0.9 && st.nod <= 0 && Math.random() < dt / 7) st.nod = 2.4;
    st.nod = Math.max(0, st.nod - dt);
    if (still) {
      for (const s of Object.values(S)) { s.x = 0; s.v = 0; }
    } else {
      const lookA = clamp(fx / 520, -1, 1) * 0.065 * st.lookOn + wind(t, 0.21, 0.13) * 0.015 * (1 - st.lookOn);
      // (dozing over the easel her head sinks forward)
      const sink = st.easel ? st.doze : 0;
      const lookY = clamp(fy / 600, -1, 1) * 5 * st.lookOn + sink * 6;
      const nodA = st.nod > 0 ? Math.sin(Math.PI * Math.min(1, (2.4 - st.nod) / 2.4)) * 0.095 : 0;
      const edgeA = st.tk * lerp(0.06, -0.05, st.peek) + st.doze * Math.sin(t * 1.3) * 0.012 + sink * 0.1;
      step(S.head, lookA + nodA + edgeA + st.tilt + (st.want === 'dismay' ? -0.05 : 0) + (st.want === 'happy' ? 0.04 : 0), dt);
      step(S.hx, lookY, dt);
      const headV = S.head.v;
      // loose parts: wind, the head's swing, gravity when she is turned (in the side the edge is her floor), the
      // drag's swing
      const sw = held ? clamp(-st.rotV, -2.5, 2.5) : 0;
      const rr = clamp(st.rot - (side ? this.sideBase() : 0), -0.75, 0.75);
      step(S.hat, -headV * 0.06 + wind(t, 0.9, 1.7) * 0.006 - rr * 0.05 + sw * 0.02, dt);
      step(S.tip, -headV * 0.25 + wind(t, 1.3, 2.1) * 0.05 - rr * 0.3 + sw * 0.06, dt);
      step(S.ah, -headV * 0.7 + wind(t, 2.1, 3.3) * 0.08 + st.ahDroop * 0.9 + st.doze * 0.45 - rr * 0.5 + sw * 0.09 + (st.sqV < -1 ? 0.2 : 0), dt);
      step(S.bL, -headV * 0.5 + wind(t, 0.8, 1.9) * 0.05 - rr * 0.9 + sw * 0.12, dt);
      step(S.bR, -headV * 0.5 + wind(t, 0.7, 1.6) * 0.05 - rr * 0.9 + sw * 0.12, dt);
      step(S.hairL, wind(t, 0.5, 0.83) * 4 - rr * 40 + sw * 6, dt);
      step(S.hairR, wind(t, 0.47, 0.91) * 4 - rr * 40 + sw * 6, dt);
      // (the arms are drawn over her hair, which they would drag along: they swing less than the rest)
      step(S.armL, wind(t, 0.6, 0.37) * 0.012 - rr * 0.4 + sw * 0.05 + (held ? -0.12 : 0), dt);
      step(S.armR, wind(t, 0.55, 0.41) * 0.012 - rr * 0.4 + sw * 0.05 + (held ? 0.12 : 0), dt);
      step(S.skirt, wind(t, 0.6, 1.1) * 2.5 - rr * 55 + sw * 8, dt);
      step(S.cup, wind(t, 1.1, 1.8) * 0.06 - rr * 0.95 + sw * 0.15, dt);
      for (const [k, m] of [['hat', 0.25], ['tip', 0.6], ['ah', 0.9], ['bL', 0.9], ['bR', 0.9], ['armL', 0.3], ['armR', 0.3], ['cup', 1], ['hairL', 26], ['hairR', 26], ['skirt', 30]] as const) S[k].x = clamp(S[k].x, -m, m);
    }
    // expressions: the wanted face eases in; blinks on their own clock
    for (const k of FACES) st.expr[k] += ((st.want === k ? 1 : 0) - st.expr[k]) * Math.min(1, dt * 14);
    if (st.blinkT < 0 && t > st.blinkAt && st.want !== 'happy') st.blinkT = 0;
    if (st.blinkT >= 0) {
      st.blinkT += dt;
      const b = st.blinkT;
      st.expr.blink = b < 0.06 ? b / 0.06 : b < 0.1 ? 1 : b < 0.17 ? 1 - (b - 0.1) / 0.07 : 0;
      if (b > 0.17) { st.blinkT = -1; st.blinkAt = t + (Math.random() < 0.2 ? 0.25 : 2.4 + Math.random() * 3.6); }
    }
    if (st.nod > 0) st.expr.blink = Math.max(st.expr.blink, 0.85 * Math.sin(Math.PI * Math.min(1, (2.4 - st.nod) / 2.4)));
    st.expr.blink = Math.max(st.expr.blink, st.doze);
    st.ahDroop += ((st.want === 'dismay' ? 1 : 0) - st.ahDroop) * Math.min(1, dt * 4);
    // her working look: the brim's right side flips up against the brush pinned in the band, quick and overshooting;
    // when the work is done it slips off the pin, tips over slowly and droops softly back, its far end trailing, and
    // only where the old brim hangs do the two cross-fade (still: a cross-fade, the flap in place); asleep over the
    // easel it slips off the pin too, and flips back up when she wakes to work on
    const H = st.brim, up = H.up && !st.asleep;
    if (still) {
      H.a = 0; H.v = 0;
      H.k += Math.sign((up ? 1 : 0) - H.k) * Math.min(Math.abs((up ? 1 : 0) - H.k), dt / 0.2);
    } else if (up) {
      if (H.k === 0) { H.a = BRIM_DOWN; H.v = 0; S.hat.v -= 0.9; S.tip.v -= 3; }
      H.t = 0;
      H.k = Math.min(1, H.k + dt / 0.08);
      H.v += (-50 * H.a - 7.8 * H.v) * dt; H.a += H.v * dt;
    } else if (H.k > 0) {
      H.t += dt;
      H.v += (30 * Math.min(1, H.t / 0.3) ** 2 * (BRIM_DOWN - H.a) - 8 * H.v) * dt; H.a += H.v * dt;
      if (H.a > BRIM_DOWN * 0.9) {
        if (H.k === 1) S.tip.v += 2;
        H.k = Math.max(0, H.k - dt / 0.22);
      }
    }
    H.bend = still ? 0 : clamp(-H.v * 0.03, -0.4, 0.4);

    // the box: its cover swings on the hinge (still: a cross-fade), it shrinks while she rests in it
    const B = st.box;
    if (still) {
      const to = B.want > 0.5 ? 1 : 0;
      this.fadeOpen += Math.sign(to - this.fadeOpen) * Math.min(Math.abs(to - this.fadeOpen), dt / 0.2);
      B.ang = this.fadeOpen > 0.5 ? this.box.openAngle : 0; B.av = 0; B.open = this.fadeOpen;
      B.pop = 0; B.shake = 0;
    } else {
      this.box.hinge(B, B.want, B.crack, dt);
      B.pop = Math.max(0, B.pop - dt * 3);
      B.shake = Math.max(0, B.shake - dt * 1.6);
    }
    this.box.stepFade(dt);
    B.zoom += ((st.paint ? 1 : 0) - B.zoom) * Math.min(1, dt * 4);
    B.small += (B.smallTo - B.small) * Math.min(1, dt * 6);
    B.glow += ((B.crack > 0.5 ? 1 : 0) - B.glow) * Math.min(1, dt * 3);
    B.show += Math.sign(B.showTo - B.show) * Math.min(Math.abs(B.showTo - B.show), dt / 0.15);
    {
      const [tx, ty] = this.boxTarget();
      if (B.cx < 0 || still) { B.cx = tx; B.cy = ty; B.vx = B.vy = 0; }
      else {
        B.vx += (90 * (tx - B.cx) - 11 * B.vx) * dt; B.vy += (90 * (ty - B.cy) - 11 * B.vy) * dt;
        B.cx += B.vx * dt; B.cy += B.vy * dt;
      }
    }
    this.tick();
  }

  /** Is anything moving fast enough to want 60 frames a second? */
  lively() {
    const st = this.st;
    return st.mode === 'drag' || st.mode === 'fall' || st.mode === 'dive' || !!st.hop || !!st.fly || Math.abs(st.box.av) > 40
      || Math.abs(st.box.small - st.box.smallTo) > 0.01 || Math.abs(st.gone - st.goneTo) > 0.01 || Math.abs(st.duck - st.duckTo) > 0.01
      || (st.brim.k > 0 && st.brim.k < 1) || Math.abs(st.brim.v) > 0.05;
  }
}
