// The 2D layer: motes of paint, a puff of smoke, glints, the finished picture's flight, and the light from the small
// paintbox's crack. Stepped with her simulation, drawn with her frame.
import type { Motion } from './motion.js';
import { lerp, sm, type Box4, type Flight, type Vec } from './state.js';

const MOTE = ['#d9a85a', '#c88a3c', '#f0cf8e', '#b0743a', '#e8bf74'];
const SMOKE = ['132,104,78', '150,124,96', '112,88,66', '170,146,116'];

interface FlyPose { x: number; y: number; w: number; h: number; rot: number; edge: number; alpha: number }

export class Effects {
  private pose: FlyPose | null = null;

  constructor(private readonly m: Motion) {}

  get alive() { const st = this.m.st; return st.motes.length > 0 || st.smoke.length > 0 || st.sparks.length > 0 || !!st.fly || st.box.glow > 0.01; }

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
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
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
      const r = s.r * (0.6 + q * 2.4);
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
