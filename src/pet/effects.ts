// The 2D layer: motes of paint, a puff of smoke, glints, the finished picture's flight, the light from the small
// paintbox's crack, the faults' acts (the blank type block, the key, the gold thread) and the bubble she blows asleep
// over the easel. Stepped with her simulation, drawn with her frame.
import { loadBitmap } from './gl.js';
import type { Motion } from './motion.js';
import { clamp, lerp, sm, type Box4, type FaultFx, type Flight, type Vec } from './state.js';

const MOTE = ['#d9a85a', '#c88a3c', '#f0cf8e', '#b0743a', '#e8bf74'];
const SMOKE = ['132,104,78', '150,124,96', '112,88,66', '170,146,116'];
const DUST = ['222,214,198', '206,198,182', '232,226,212', '196,188,172'];
// the faults' acts: how long each runs (s) (dry: only her watching the pans); the key's shaft as a share of its
// picture's height
const FAULT_SECONDS: Record<string, number> = { blank: 2.6, key: 2.6, thread: 2.3, dry: 1.6 };
const KEY_AXIS = 0.517;
// the bubble: where it hangs from (her nostril, texture px), its size at full breath out (texture px), how long the
// pop takes (s)
const NOSE: Vec = [452, 524];
const BUBBLE = 58;
const POP = 0.3;
const ease = (k: number) => { const t = clamp(k, 0, 1); return t * t * (3 - 2 * t); };
const back = (k: number) => { const t = clamp(k, 0, 1) - 1; return 1 + 2.4 * t * t * t + 1.4 * t * t; };

interface FlyPose { x: number; y: number; w: number; h: number; rot: number; edge: number; alpha: number }

export class Effects {
  private pose: FlyPose | null = null;
  private img: { block: ImageBitmap | null; key: ImageBitmap | null } = { block: null, key: null };
  // the bubble: on is its share while it comes, pop how far its burst has gone (-1: none), x y r where it is
  private bub = { on: 0, pop: -1, x: 0, y: 0, r: 0 };

  constructor(private readonly m: Motion) {}

  /** The faults' two objects (GPT's, on a transparent ground). */
  async load(url: (file: string) => string, signal: AbortSignal) {
    const [block, key] = await Promise.all([loadBitmap(url('fx_block.webp'), signal), loadBitmap(url('fx_key.webp'), signal)]);
    this.img.block?.close(); this.img.key?.close();
    this.img = { block, key };
  }

  get alive() { const st = this.m.st; return st.motes.length > 0 || st.smoke.length > 0 || st.sparks.length > 0 || !!st.fly || st.box.glow > 0.01 || !!st.fault || this.bub.on > 0; }

  step(dt: number) {
    const m = this.m, st = m.st, f = m.fig();
    // motes: little beads of gold-tea paint lifting off the palette and gathering on the lid
    const P = st.paint;
    if (P && P.emit && !P.lifted && st.box.open > 0.6 && !m.still && !st.away) {
      P.acc += dt * 55;
      while (P.acc > 1) {
        P.acc -= 1;
        const F = m.boxFrame();
        const [x, y] = m.box.palettePoint(F);
        const lid = m.box.sheetScreen(F, st.box.ang, P.aspect);
        const u = Math.random(), v = Math.random();
        const tx = lerp(lerp(lid[0][0], lid[1][0], u), lerp(lid[3][0], lid[2][0], u), v), ty = lerp(lerp(lid[0][1], lid[1][1], u), lerp(lid[3][1], lid[2][1], u), v);
        st.motes.push({ x, y, x0: x, y0: y, tx, ty, t: 0, life: 0.9 + Math.random() * 0.8, r: (0.8 + Math.random() * 1.6) * f / 260, c: MOTE[(Math.random() * MOTE.length) | 0], sw: (Math.random() - 0.5) * 60 });
      }
    }
    for (const q of st.motes) {
      q.t += dt;
      const k = Math.min(1, q.t / q.life), e2 = k * k * (3 - 2 * k);
      const arc = Math.sin(k * Math.PI) * (40 + q.sw) * f / 260;
      q.x = lerp(q.x0, q.tx, e2) + Math.sin(k * 6 + q.sw) * 6 * f / 260;
      q.y = lerp(q.y0, q.ty, e2) - arc;
    }
    st.motes = st.motes.filter(q => q.t < q.life);
    // smoke: soft tea-brown puffs from the palette, rising and spreading
    for (const s of st.smoke) {
      s.t += dt;
      if (s.t < 0) continue;
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy *= 0.975; s.vx *= 0.96;
    }
    st.smoke = st.smoke.filter(s => s.t < s.life);
    for (const s of st.sparks) s.t += dt;
    st.sparks = st.sparks.filter(s => s.t < s.life);
    this.pose = st.fly ? this.fly(st.fly, dt) : null;
    const Q = st.fault;
    if (Q) {
      Q.t += dt;
      this.cue(Q);
      if (Q.t > (FAULT_SECONDS[Q.act] ?? 0)) st.fault = null;
    }
    // (she watches it go wrong; the blank block puzzles her: her head tilts towards it)
    st.gaze = st.fault ? this.gazeAt(st.fault) : null;
    st.tilt = st.fault?.act === 'blank' && st.fault.t > 0.45 && st.fault.t < 2.15 ? (st.onLeft ? 0.1 : -0.1) : 0;
    this.bubble(dt);
  }

  private gazeAt(Q: FaultFx): Vec {
    const m = this.m, r = m.boxRect();
    if (Q.act === 'blank') { const p = this.blankPose(Q.t); if (p) return [p.x, p.y]; }
    if (Q.act === 'key') return m.box.keyPoint(m.boxFrame());
    if (Q.act === 'thread') {
      // (down the thread with its beads, then the break)
      const [end, far] = this.threadEnds(), k = clamp(Q.t / 1.3, 0, 1);
      return Q.at ?? [lerp(far[0], end[0], k), lerp(far[1], end[1], k)];
    }
    return [r.x + r.w * 0.45, r.y + r.h * 0.65];
  }

  // asleep over the easel she blows a bubble from her nose: it swells as she breathes out and shrinks as she breathes
  // in, and it pops when she wakes
  private bubble(dt: number) {
    const m = this.m, st = m.st, B = this.bub;
    if (st.asleep && st.easel && !m.still && !st.away && m.visible()) { B.on = Math.min(1, B.on + dt / 1.6); B.pop = -1; }
    else if (B.on > 0 && B.pop < 0) B.pop = 0;
    if (B.pop >= 0) {
      B.pop += dt;
      if (B.pop > POP) { B.pop = -1; B.on = 0; }
      return;
    }
    if (B.on <= 0) return;
    const br = (Math.sin(st.t * (Math.PI * 2 / 3.8)) + 1) * 0.5, out = (1 - br) ** 1.3;
    B.r = BUBBLE * m.scale() * B.on * (0.3 + 0.7 * out);
    // (it hangs from the nostril, out in front of her face and down)
    const [nx, ny] = m.headToScreen(NOSE[0], NOSE[1]), a = st.rot + m.S.head.x;
    const dx = -0.8 * Math.cos(a) - 0.6 * Math.sin(a), dy = -0.8 * Math.sin(a) + 0.6 * Math.cos(a);
    B.x = nx + dx * B.r * 0.9; B.y = ny + dy * B.r * 0.9;
  }

  private drawBubble(fx: CanvasRenderingContext2D) {
    const { x, y, r, pop } = this.bub, TAU = Math.PI * 2;
    if (r < 0.5) return;
    fx.save();
    if (pop >= 0) {
      // (the burst: its film flies apart in shreds and drops)
      const k = pop / POP, d = r * (1 + k * 0.8);
      fx.globalAlpha = (1 - k) * 0.85; fx.strokeStyle = 'rgb(112,160,210)'; fx.lineWidth = Math.max(0.9, r * 0.07); fx.lineCap = 'round';
      for (let i = 0; i < 7; i++) { const a = i / 7 * TAU + 0.4; fx.beginPath(); fx.arc(x, y, d, a, a + 0.42 * (1 - k)); fx.stroke(); }
      fx.fillStyle = 'rgb(176,214,246)';
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * TAU + 0.15, q = r * (1 + k * 1.7);
        fx.beginPath(); fx.arc(x + Math.cos(a) * q, y + Math.sin(a) * q + k * k * r * 0.8, Math.max(0.5, r * 0.08 * (1 - k)), 0, TAU); fx.fill();
      }
      fx.restore();
      return;
    }
    // the film, drawn the way a picture book draws it (it has to show on her skin): pale blue, deeper towards a blue
    // rim, a lighter ring inside it, a faint rainbow, a curved window of light
    const g = fx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(228,243,255,0.16)'); g.addColorStop(0.75, 'rgba(184,218,246,0.26)'); g.addColorStop(1, 'rgba(160,200,240,0.46)');
    fx.fillStyle = g; fx.beginPath(); fx.arc(x, y, r, 0, TAU); fx.fill();
    fx.strokeStyle = 'rgba(92,136,188,0.78)'; fx.lineWidth = Math.max(0.9, r * 0.07); fx.beginPath(); fx.arc(x, y, r, 0, TAU); fx.stroke();
    fx.strokeStyle = 'rgba(255,255,255,0.5)'; fx.lineWidth = Math.max(0.7, r * 0.05); fx.beginPath(); fx.arc(x, y, r * 0.88, 0, TAU); fx.stroke();
    fx.lineWidth = Math.max(0.8, r * 0.08); fx.lineCap = 'round';
    fx.strokeStyle = 'rgba(255,170,210,0.4)'; fx.beginPath(); fx.arc(x, y, r * 0.8, 0.15 * Math.PI, 0.6 * Math.PI); fx.stroke();
    fx.strokeStyle = 'rgba(150,226,255,0.4)'; fx.beginPath(); fx.arc(x, y, r * 0.8, 0.62 * Math.PI, 0.85 * Math.PI); fx.stroke();
    fx.strokeStyle = 'rgba(255,255,255,0.92)'; fx.lineWidth = Math.max(1, r * 0.13);
    fx.beginPath(); fx.arc(x, y, r * 0.66, 1.1 * Math.PI, 1.42 * Math.PI); fx.stroke();
    fx.fillStyle = 'rgba(255,255,255,0.92)'; fx.beginPath(); fx.arc(x - r * 0.12, y - r * 0.7, Math.max(0.6, r * 0.07), 0, TAU); fx.fill();
    fx.restore();
  }

  // the faults' glints, each once at its moment: the name the block has not got, the key jamming, the thread's break
  private cue(Q: FaultFx) {
    const at = Q.act === 'blank' ? [0.75] : Q.act === 'key' ? [0.49, 1.04, 1.59] : Q.act === 'thread' ? [1.55] : [];
    while (Q.cues < at.length && Q.t >= at[Q.cues]) {
      const m = this.m, F = m.boxFrame(), w = m.boxWidth();
      if (Q.act === 'blank') { const p = this.blankPose(Q.t); if (p) this.glints([[p.x + p.w * 0.1, p.y - p.h * 0.42]], 2.5, 1.5, 0.3, 0); }
      else if (Q.act === 'key') { const k = m.box.keyPoint(F); this.glints([[k[0] - w * 0.015, k[1] - w * 0.01]], 3.5, 2, 0.28, 0); }
      else if (Q.at) this.glints([Q.at, [Q.at[0] + 4, Q.at[1] - 3], [Q.at[0] - 3, Q.at[1] + 4]], 4, 3, 0.45, 0.04);
      Q.cues++;
    }
  }

  // the finished picture, framed, on its way to the floor
  private fly(F: Flight, dt: number): FlyPose | null {
    F.t += dt;
    let x, y, w, h, rot, k = 0;
    if (F.t < F.hold) {
      const a = F.t / F.hold;
      x = F.from.x; y = F.from.y - a * 18; w = F.from.w * (1 + a * 0.1); h = F.from.h * (1 + a * 0.1); rot = -0.04 * a;
    } else {
      k = Math.min(1, (F.t - F.hold) / (F.dur - F.hold));
      const ek = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      if (k >= 0.8 && !F.nearDone) { F.nearDone = true; F.near?.(); }
      const to = F.to();
      const sx = F.from.x, sy = F.from.y - 18;
      const cx = lerp(sx, to.x, 0.5), cy = Math.min(sy, to.y) - 160;
      x = (1 - ek) ** 2 * sx + 2 * (1 - ek) * ek * cx + ek * ek * to.x;
      y = (1 - ek) ** 2 * sy + 2 * (1 - ek) * ek * cy + ek * ek * to.y;
      w = lerp(F.from.w * 1.1, to.w, ek); h = lerp(F.from.h * 1.1, to.h, ek); rot = lerp(-0.04, 0, ek) + Math.sin(ek * Math.PI) * 0.08;
      if (k >= 1 && !F.landed) { F.landed = true; F.onLand(); }
    }
    if (F.landed) { if (this.m.st.fly === F) this.m.st.fly = null; return null; }
    // (its wooden frame melts away on the way in: the floor has a frame of its own)
    const edge = F.t < F.hold ? 1 : 1 - sm(0.55, 0.95, k);
    return { x, y, w, h, rot, edge, alpha: F.fade ? 1 - sm(0.5, 1, k) : 1 };
  }

  bounds(): Box4 | null {
    const st = this.m.st;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const take = (x: number, y: number, r: number) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
    for (const q of st.motes) take(q.x, q.y, q.r * 3.2 + 1);
    for (const s of st.smoke) if (s.t >= 0) take(s.x, s.y, s.r * 3.2 + 1);
    for (const s of st.sparks) take(s.x, s.y, s.r * 1.6 + 2);
    const p = this.pose;
    if (p) take(p.x + p.w / 2, p.y + p.h / 2, Math.hypot(p.w, p.h) * 0.55 + Math.max(3, p.w * 0.045) * 2.4 + 22);
    if (st.box.glow > 0.01) { const c = this.crack(); take(c[0], c[1], this.m.smallWidth() * 0.9); }
    if (st.fault) {
      const r = this.m.boxRect(), w = r.w;
      take(r.x + w / 2, r.y + r.h / 2, w * 1.1);
      if (st.fault.act === 'thread') { const [, far] = this.threadEnds(); take(far[0], far[1], 12); }
    }
    if (this.bub.on > 0) take(this.bub.x, this.bub.y, this.bub.r * 2.8 + 4);
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  // ---- the faults ----------------------------------------------------------------------------------------------------
  // the blank type block: out of its slot in the rack and up, turning a little as if to show the name it has not got,
  // then back down into the rack
  private blankPose(t: number) {
    const m = this.m, img = this.img.block;
    if (!img) return null;
    const { at, out } = m.box.rackPoint(m.boxFrame(), m.st.box.ang), w = m.boxWidth();
    const up = t < 0.32 ? back(t / 0.32) : t < 2.1 ? 1 : 1 - ease((t - 2.1) / 0.36);
    const hover = t > 0.32 && t < 2.1 ? Math.sin((t - 0.32) * 4.4) : 0;
    // (it grows as it comes up out of the rack, to be seen)
    const h = w * lerp(0.12, 0.24, up), bw = h * img.width / img.height;
    return {
      x: at[0] + out[0] * w * 0.05 * up, y: at[1] - w * 0.27 * up + hover * w * 0.012, w: bw, h,
      rot: t > 0.32 && t < 2.1 ? Math.sin((t - 0.32) * 2.7) * 0.15 : 0, a: t < 0.08 ? t / 0.08 : t > 2.42 ? 1 - ease((t - 2.42) / 0.18) : 1,
    };
  }

  private drawBlank(fx: CanvasRenderingContext2D, t: number) {
    const p = this.blankPose(t), img = this.img.block;
    if (!p || !img) return;
    fx.save(); fx.globalAlpha = p.a; fx.translate(p.x, p.y); fx.rotate(p.rot);
    fx.shadowColor = 'rgba(40,24,10,.35)'; fx.shadowBlur = 6; fx.shadowOffsetY = 3;
    fx.drawImage(img, -p.w / 2, -p.h / 2, p.w, p.h);
    fx.restore();
  }

  // the key: into the keyhole under the clasp, three turns that jam with a jolt (it twists about its shaft, so its bow
  // narrows), then out, and it drops away
  private drawKey(fx: CanvasRenderingContext2D, t: number) {
    const m = this.m, img = this.img.key;
    if (!img) return;
    const w = m.boxWidth(), L = w * 0.42, H = L * img.height / img.width, hole = m.box.keyPoint(m.boxFrame());
    const dir = Math.atan2(-0.36, -0.62);
    let depth = (1 - ease(t / 0.25)) * 0.3, twist = 0, jolt = 0, fall = 0, a = Math.min(1, t / 0.1);
    for (const t0 of [0.4, 0.95, 1.5]) {
      const q = t - t0;
      if (q < 0 || q >= 0.42) continue;
      twist = q < 0.09 ? q / 0.09 * 0.6 : q < 0.24 ? 0.6 : 0.6 * (1 - ease((q - 0.24) / 0.18));
      if (q >= 0.09 && q < 0.24) jolt = Math.sin((q - 0.09) * 150) * 0.06 * (1 - (q - 0.09) / 0.15);
    }
    if (t > 2.0) {
      const q = t - 2.0;
      depth = ease(q / 0.25) * 0.3;
      fall = q > 0.2 ? (q - 0.2) ** 2 * w * 2.6 : 0;
      a = 1 - ease((q - 0.25) / 0.35);
    }
    fx.save(); fx.globalAlpha = a;
    fx.translate(hole[0] - Math.cos(dir) * depth * L, hole[1] - Math.sin(dir) * depth * L + fall);
    fx.rotate(dir + jolt); fx.scale(1, Math.cos(twist));
    fx.shadowColor = 'rgba(40,24,10,.35)'; fx.shadowBlur = 5; fx.shadowOffsetY = 3;
    fx.drawImage(img, -L, -H * KEY_AXIS, L, H);
    fx.restore();
  }

  // the gold thread the paint comes along from afar (up and out over the page): it reaches the pans, beads of light
  // run down it, it flickers and snaps, and the two ends whip back and fade
  private threadEnds(): [Vec, Vec] {
    const m = this.m, st = m.st, f = m.fig(), r = m.box.rect(m.boxFrame());
    const end: Vec = [r.x + r.w * 0.42, r.y + r.h * 0.42];
    const away = st.onLeft ? 1 : -1;
    return [end, [clamp(end[0] + away * f * 0.55, 8, m.view.w - 8), Math.max(8, end[1] - f * 1.15)]];
  }

  private drawThread(fx: CanvasRenderingContext2D, Q: FaultFx) {
    const t = Q.t, [end, far] = this.threadEnds(), sc = this.m.fig() / 296;
    const dx = end[0] - far[0], dy = end[1] - far[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const cx = (far[0] + end[0]) / 2 + nx * len * 0.14, cy = (far[1] + end[1]) / 2 + ny * len * 0.14;
    const at = (u: number, wig = 0): Vec => {
      const v = 1 - u;
      return [v * v * far[0] + 2 * v * u * cx + u * u * end[0] + nx * wig, v * v * far[1] + 2 * v * u * cy + u * u * end[1] + ny * wig];
    };
    const B = 0.55, snap = 1.55;
    if (t >= snap && !Q.at) Q.at = at(B);
    const line = (u0: number, u1: number, alpha: number, whip: number, from: number) => {
      if (u1 - u0 < 0.004 || alpha <= 0.01) return;
      const n = Math.max(2, Math.ceil((u1 - u0) * 40));
      const pts: Vec[] = [];
      for (let i = 0; i <= n; i++) {
        const u = lerp(u0, u1, i / n), near = Math.max(0, 1 - Math.abs(u - from) / 0.25);
        pts.push(at(u, Math.sin(u * 46 + t * 34) * whip * near * len * 0.03));
      }
      const path = () => { fx.beginPath(); pts.forEach(([x, y], i) => (i ? fx.lineTo(x, y) : fx.moveTo(x, y))); };
      fx.lineCap = 'round'; fx.lineJoin = 'round';
      fx.globalAlpha = alpha * 0.32; fx.strokeStyle = '#f2c36a'; fx.lineWidth = 4.2 * sc; path(); fx.stroke();
      fx.globalAlpha = alpha; fx.strokeStyle = '#ffe8ad'; fx.lineWidth = 1.4 * sc; path(); fx.stroke();
    };
    if (t < snap) {
      // (it reaches down from afar, carries its beads, then flickers)
      const g = ease(t / 0.35), flick = t > 1.28 ? 0.45 + 0.55 * Math.abs(Math.sin(t * 64)) : 1;
      line(0, g, flick, 0, 0);
      if (t > 0.35 && t < 1.3) for (let i = 0; i < 4; i++) {
        const u = ((t - 0.35) * 1.3 + i / 4) % 1, [x, y] = at(u), r = 2.2 * sc;
        const gr = fx.createRadialGradient(x, y, 0, x, y, r * 3);
        gr.addColorStop(0, 'rgba(255,240,196,.95)'); gr.addColorStop(1, 'rgba(242,195,106,0)');
        fx.globalAlpha = 1; fx.fillStyle = gr; fx.beginPath(); fx.arc(x, y, r * 3, 0, Math.PI * 2); fx.fill();
      }
    } else {
      // snapped: the far end draws back towards where it came from, the near end back down into the box
      const k = ease((t - snap) / 0.55), a = 1 - ease((t - snap - 0.15) / 0.6), whip = 1 - k;
      line(0, B * (1 - k), a, whip, B * (1 - k));
      line(B + (1 - B) * k, 1, a, whip, B + (1 - B) * k);
    }
    fx.globalAlpha = 1;
  }

  // dust off the pans as they run dry: a breath of fine pale powder, hardly rising
  dust() {
    const m = this.m, st = m.st;
    if (m.still) return;
    const F = m.boxFrame();
    for (let i = 0; i < 24; i++) {
      const [x, y] = m.box.palettePoint(F);
      st.smoke.push({ x, y, vx: (Math.random() - 0.5) * 30, vy: -8 - Math.random() * 22, r: (1.3 + Math.random() * 1.6) * m.fig() / 260,
        t: -i * 0.03, life: 0.9 + Math.random() * 0.7, c: DUST[i % 4], grow: 0.6 });
    }
  }

  private crack(): Vec { return this.m.box.crackPoint(this.m.boxFrame()); }

  draw(fx: CanvasRenderingContext2D) {
    const m = this.m, st = m.st, f = m.fig();
    // the small paintbox at work on its own: light from its crack
    if (st.box.glow > 0.01) {
      const [x, y] = this.crack(), r = m.smallWidth() * 0.9, a = st.box.glow * (0.55 + 0.25 * Math.sin(st.t * 3));
      const g = fx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,226,150,.9)'); g.addColorStop(0.35, 'rgba(240,190,96,.45)'); g.addColorStop(1, 'rgba(240,190,96,0)');
      fx.save(); fx.globalCompositeOperation = 'lighter'; fx.globalAlpha = a; fx.fillStyle = g;
      fx.beginPath(); fx.arc(x, y, r, 0, Math.PI * 2); fx.fill(); fx.restore();
    }
    for (const q of st.motes) {
      const k = Math.min(1, q.t / q.life), a = Math.sin(k * Math.PI) * 0.9;
      const g = fx.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.r * 3.2);
      g.addColorStop(0, q.c); g.addColorStop(0.45, q.c + 'aa'); g.addColorStop(1, q.c + '00');
      fx.globalAlpha = a; fx.fillStyle = g; fx.beginPath(); fx.arc(q.x, q.y, q.r * 3.2, 0, Math.PI * 2); fx.fill();
      fx.globalAlpha = a * 0.8; fx.fillStyle = '#fff6dc'; fx.beginPath(); fx.arc(q.x - q.r * 0.3, q.y - q.r * 0.3, q.r * 0.55, 0, Math.PI * 2); fx.fill();
    }
    for (const s of st.smoke) {
      if (s.t < 0) continue;
      const q = s.t / s.life;
      const r = s.r * (0.6 + q * (s.grow ?? 2.4));
      const a = q < 0.12 ? q / 0.12 : 1 - (q - 0.12) / 0.88;
      const g = fx.createRadialGradient(s.x - r * 0.2, s.y - r * 0.25, 0, s.x, s.y, r);
      g.addColorStop(0, `rgba(${s.c},${0.78 * a})`); g.addColorStop(0.55, `rgba(${s.c},${0.5 * a})`); g.addColorStop(0.85, `rgba(${s.c},${0.16 * a})`); g.addColorStop(1, `rgba(${s.c},0)`);
      fx.globalAlpha = 1; fx.fillStyle = g; fx.beginPath(); fx.arc(s.x, s.y, r, 0, Math.PI * 2); fx.fill();
    }
    // glints
    for (const s of st.sparks) {
      if (s.t < 0) continue;
      const q = s.t / s.life, a = Math.sin(q * Math.PI), L = s.r * (0.6 + a);
      fx.save(); fx.translate(s.x, s.y); fx.rotate(s.a + q * 0.6); fx.globalAlpha = a;
      fx.strokeStyle = '#fff3c8'; fx.lineWidth = 1.4; fx.beginPath(); fx.moveTo(-L, 0); fx.lineTo(L, 0); fx.moveTo(0, -L * 0.7); fx.lineTo(0, L * 0.7); fx.stroke();
      fx.restore();
    }
    fx.globalAlpha = 1;
    if (this.bub.on > 0) this.drawBubble(fx);
    const Q = st.fault;
    if (Q?.act === 'blank') this.drawBlank(fx, Q.t);
    else if (Q?.act === 'key') this.drawKey(fx, Q.t);
    else if (Q?.act === 'thread') this.drawThread(fx, Q);
    const p = this.pose;
    if (p && st.fly) this.frameDraw(fx, p, st.fly.img);
    void f;
  }

  private frameDraw(fx: CanvasRenderingContext2D, p: FlyPose, img: ImageBitmap) {
    const { x, y, w, h, rot, edge } = p, a = p.alpha;
    fx.save(); fx.translate(x + w / 2, y + h / 2); fx.rotate(rot); fx.globalAlpha = a;
    const fw = Math.max(3, w * 0.045);
    fx.shadowColor = 'rgba(40,24,10,.45)'; fx.shadowBlur = 14; fx.shadowOffsetY = 5;
    fx.globalAlpha = a * edge;
    fx.fillStyle = '#6b4a2c'; fx.fillRect(-w / 2 - fw, -h / 2 - fw, w + fw * 2, h + fw * 2);
    fx.globalAlpha = a;
    if (edge < 1) fx.fillRect(-w / 2, -h / 2, w, h);
    fx.shadowColor = 'transparent';
    fx.drawImage(img, -w / 2, -h / 2, w, h);
    fx.globalAlpha = a * edge;
    fx.strokeStyle = '#3e2a17'; fx.lineWidth = 1; fx.strokeRect(-w / 2, -h / 2, w, h);
    // brass corner guards, as on the plugin's frames
    const c = fw * 2.4;
    fx.fillStyle = '#c8a24f'; fx.strokeStyle = '#7a5a22'; fx.lineWidth = 0.8;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      fx.beginPath();
      const X = sx * (w / 2 + fw), Y = sy * (h / 2 + fw);
      fx.moveTo(X, Y); fx.lineTo(X - sx * c, Y); fx.lineTo(X - sx * c, Y - sy * fw * 0.8); fx.lineTo(X - sx * fw * 0.8, Y - sy * fw * 0.8);
      fx.lineTo(X - sx * fw * 0.8, Y - sy * c); fx.lineTo(X, Y - sy * c); fx.closePath(); fx.fill(); fx.stroke();
    }
    fx.restore();
  }

  // a little puff of tea-brown smoke, the way a pot coughs: a burst, then the rest rolling up and away
  puff() {
    const m = this.m, st = m.st;
    if (m.still) return;
    const F = m.boxFrame();
    for (let i = 0; i < 22; i++) {
      const [x, y] = m.box.palettePoint(F);
      const burst = i < 8;
      st.smoke.push({ x, y, vx: (Math.random() - 0.5) * (burst ? 140 : 60), vy: -(burst ? 90 : 45) - Math.random() * 80,
        r: (burst ? 9 : 12 + Math.random() * 10) * m.fig() / 260, t: burst ? -i * 0.015 : -0.12 - i * 0.035, life: 1.3 + Math.random() * 0.9,
        c: SMOKE[i % 4] });
    }
  }

  /** Glints over the sheet (the picture is in) or at a frame's corners (it landed). */
  glints(points: Vec[], r: number, spread: number, life: number, stagger: number) {
    if (this.m.still) return;
    points.forEach(([x, y], i) => this.m.st.sparks.push({ x, y, r: r + Math.random() * spread, a: Math.random(), t: -i * stagger, life }));
  }
}
