// The stage: one layer in the plugin's shadow root holding two small canvases (GL for her and the paintbox, 2D for the
// effects) that cover only what is drawn, the note and the launcher with its hit parts; the frame loop with its rates
// (60 while she moves, 30 at work, 24 awake, 12 resting; nothing while the page is hidden); no draw when nothing moved.
import { Gfx, loadBitmap, paperCanvas, pixels, shadowCanvas, gridMesh, type Mesh, type Tex } from './gl.js';
import type { Acts } from './acts.js';
import type { Effects } from './effects.js';
import type { Input } from './input.js';
import type { Motion } from './motion.js';
import type { Speech } from './speech.js';
import { TIA_FILES, TW, TH, R, type Rig, type TiaTex } from './tia.js';
import { clamp, type Box4 } from './state.js';

const STEP = 1 / 60;

export interface StageParts {
  m: Motion;
  rig: Rig;
  effects: Effects;
  speech: Speech;
  acts: Acts;
  input: () => Input | null;
  url: (file: string) => string;
}

export class Stage {
  readonly layer: HTMLDivElement;
  private readonly glc: HTMLCanvasElement;
  private readonly fxc: HTMLCanvasElement;
  private fx: CanvasRenderingContext2D | null;
  gfx: Gfx | null = null;
  private T: Record<TiaTex, Tex> | null = null;
  private ground: Tex | null = null;
  private quad: Mesh = gridMesh(1, 1);
  private lost = false;
  /** Without WebGL2: her picture and the shut paintbox as two images, no animation. */
  private still: { tia: HTMLImageElement; box: HTMLImageElement; urls: string[] } | null = null;
  // the canvases' corner on the page and size (CSS px)
  private cw = 0;
  private ch = 0;
  private ox = 0;
  private oy = 0;
  private shrinkSince = 0;
  // the loop
  private running = false;
  private raf = 0;
  private timer = 0;
  private prev = 0;
  private lastSim = 0;
  private budget = 0;
  private nearUntil = 0;
  private lastDraw = 0;
  private lastRead = 0;
  readEl: Element | null = null;
  // what was drawn last, to skip a frame when nothing moved
  private lastPos = new Float32Array(0);
  private lastSig: number[] = [];
  dirty = true;
  ready = false;

  constructor(private readonly p: StageParts, private readonly signal: AbortSignal) {
    this.layer = document.createElement('div');
    this.layer.className = 'pet-layer';
    this.layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none';
    this.glc = document.createElement('canvas');
    this.glc.className = 'pet-canvas';
    this.fxc = document.createElement('canvas');
    this.fxc.className = 'pet-canvas';
    for (const c of [this.glc, this.fxc]) { c.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none'; c.setAttribute('aria-hidden', 'true'); }
    this.layer.append(this.glc, this.fxc);
    this.fx = this.fxc.getContext('2d');
    const gl = this.glc.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true });
    if (gl) this.gfx = new Gfx(gl);
    this.glc.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.lost = true;
      this.gfx?.forget();
      this.p.m.box.lose();
      this.T = null; this.ground = null;
    }, { signal });
    this.glc.addEventListener('webglcontextrestored', () => { void this.restore(); }, { signal });
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()), { signal });
    window.addEventListener('pagehide', () => this.stop(), { signal });
    window.addEventListener('pageshow', () => { if (!document.hidden) this.start(); }, { signal });
  }

  get hasGL() { return !!this.gfx; }

  /** Her pictures and the paintbox's, the hit map; on the GPU, or as images in the still mode. */
  async load() {
    const p = this.p, signal = this.signal;
    const names = Object.keys(TIA_FILES) as TiaTex[];
    const [bitmaps] = await Promise.all([
      Promise.all(names.map(n => loadBitmap(p.url(TIA_FILES[n]), signal))),
      p.m.box.load(p.url, signal),
    ]);
    const base = bitmaps[0];
    p.rig.buildHit(pixels(base, TW, TH, Math.round(TW / 4), Math.round(TH / 4)), Math.round(TW / 4), Math.round(TH / 4));
    if (this.gfx) this.upload(names, bitmaps);
    else {
      for (const b of bitmaps) b.close();
      await this.stillPictures();
    }
  }

  private upload(names: TiaTex[], bitmaps: ImageBitmap[]) {
    const gfx = this.gfx!, rig = this.p.rig;
    const T = {} as Record<TiaTex, Tex>;
    names.forEach((n, i) => { T[n] = gfx.texture(bitmaps[i], bitmaps[i].width, bitmaps[i].height); bitmaps[i].close(); });
    this.T = T;
    const shadow = shadowCanvas();
    this.ground = gfx.texture(shadow, shadow.width, shadow.height);
    if (!this.quad.vao) for (const m of [...rig.meshes(), this.quad]) gfx.add(m);
    this.p.m.box.upload(gfx, paperCanvas());
    this.dirty = true;
  }

  private async restore() {
    const gfx = this.gfx;
    if (!gfx || this.signal.aborted) return;
    try {
      gfx.build();
      const names = Object.keys(TIA_FILES) as TiaTex[];
      const bitmaps = await Promise.all(names.map(n => loadBitmap(this.p.url(TIA_FILES[n]), this.signal)));
      await this.p.m.box.load(this.p.url, this.signal);
      if (this.signal.aborted) { for (const b of bitmaps) b.close(); return; }
      const palette = this.p.m.box.palette;
      this.upload(names, bitmaps);
      if (palette) this.p.m.box.tint(palette, false);
      this.lost = false;
      this.dirty = true;
      this.wake();
    } catch { /* she stays as she is; the next restore tries again */ }
  }

  private async stillPictures() {
    const p = this.p;
    const shut = p.m.box.shutPicture();
    const blob = await new Promise<Blob | null>(res => (shut ? shut.toBlob(res, 'image/png') : res(null)));
    const response = await fetch(p.url(TIA_FILES.base), { signal: this.signal });
    if (!response.ok || !blob) throw new Error('still pictures');
    const urls = [URL.createObjectURL(await response.blob()), URL.createObjectURL(blob)];
    const make = (src: string, w: number, h: number) => {
      const img = new Image(w, h);
      img.className = 'pet-still';
      img.alt = '';
      img.draggable = false;
      img.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px;transform-origin:0 0;pointer-events:none`;
      img.src = src;
      return img;
    };
    const tia = make(urls[0], TW, TH), box = make(urls[1], 1024, 1024);
    await Promise.all([tia.decode(), box.decode()]);
    this.layer.prepend(tia, box);
    this.still = { tia, box, urls };
  }

  // ---- the loop ----------------------------------------------------------------------------------------------------
  start() {
    if (this.running || !this.ready || this.signal.aborted || document.hidden) return;
    this.running = true;
    this.prev = this.lastSim = performance.now();
    this.budget = 1000;
    this.dirty = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf); this.raf = 0;
    clearTimeout(this.timer); this.timer = 0;
  }

  /** Something happened: the next frame now, not after a resting rate's sleep. */
  wake() {
    if (!this.running) return;
    this.dirty = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  near() {
    const now = performance.now(), before = this.nearUntil;
    this.nearUntil = now + 400;
    if (before < now) this.wake();
  }

  private rate() {
    const m = this.p.m, st = m.st, input = this.p.input();
    if (m.lively() || this.p.acts.changing || input?.dragging || performance.now() < this.nearUntil) return 60;
    if (st.casting || st.reading || st.failing) return 30;
    if (st.tucked || st.asleep || st.mode === 'side' || st.away) return 12;
    return 24;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.running) return;
    const interval = 1000 / this.rate();
    this.budget = Math.min(this.budget + now - this.prev, interval * 2);
    this.prev = now;
    if (this.budget >= interval - (interval > 20 ? 8 : 2)) {
      this.budget -= interval;
      if (this.budget > interval) this.budget = 0;
      const el = Math.min(0.25, (now - this.lastSim) / 1000);
      this.lastSim = now;
      // (substeps of at most 1/60 s: a 12 fps frame moves as five 60 fps frames do)
      if (el > 0) {
        const n = Math.max(1, Math.ceil(el / STEP - 1e-6)), dt = el / n;
        for (let i = 0; i < n; i++) this.step(dt);
      }
      this.show(now);
    }
    if (!this.running) return;
    // (sleep until the next frame is due, then one animation frame: no polling on fast screens)
    const next = 1000 / this.rate(), wait = next - (next > 20 ? 8 : 2) - this.budget;
    if (wait > 4) this.timer = window.setTimeout(() => { this.timer = 0; if (this.running) this.raf = requestAnimationFrame(this.frame); }, wait);
    else this.raf = requestAnimationFrame(this.frame);
  };

  private step(dt: number) {
    const p = this.p;
    p.m.update(dt);
    p.effects.step(dt);
    p.acts.step(dt);
  }

  // ---- a frame -----------------------------------------------------------------------------------------------------
  private show(now: number) {
    const p = this.p, m = p.m, st = m.st;
    const dt = this.lastDraw ? Math.min(0.25, (now - this.lastDraw) / 1000) : 0;
    // (what she reads: its rect twice a second, never per frame)
    if (st.reading && now - this.lastRead > 500) {
      this.lastRead = now;
      const el = this.readEl?.isConnected ? this.readEl : document.getElementById('chat');
      const r = el?.getBoundingClientRect();
      m.readAt = r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    }
    // (before her first step the box has no place yet)
    if (st.box.cx < 0) { const [x, y] = m.boxTarget(); st.box.cx = x; st.box.cy = y; }
    const herOn = !st.away && st.alpha > 0.004 && st.shrink > 0.01;
    const boxOn = st.box.show > 0.004;
    if (herOn) p.rig.pose(st, m.S, m.scale());
    const input = p.input();
    if (input) input.place(herOn && m.visible() && !p.acts.changing, boxOn && st.duck < 0.5);
    p.speech.place(dt);
    if (this.still) { this.placeStill(herOn, boxOn); this.lastDraw = now; return; }
    if (!this.gfx || this.lost || !this.T) return;
    const bounds = this.bounds(herOn, boxOn);
    const moved = this.fit(bounds, now);
    if (!moved && !this.dirty && !this.changed(herOn)) return;
    this.dirty = false;
    this.lastDraw = now;
    this.draw(herOn, boxOn);
  }

  private duckDy() { const m = this.p.m; return m.st.duck * m.fig() * 1.1; }

  private bounds(herOn: boolean, boxOn: boolean): Box4 | null {
    const p = this.p, m = p.m, st = m.st, f = m.fig(), fl = m.view.floor;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const take = (b: { x0: number; y0: number; x1: number; y1: number }) => { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); };
    const side = st.mode === 'side';
    if (herOn) {
      const b = p.rig.bounds(side);
      take({ x0: b.x0 - 4, y0: b.y0 - 4, x1: b.x1 + 4, y1: b.y1 + 4 });
      if (!side) { const feet = m.toScreen(...R.feet); take({ x0: feet[0] - f * 0.23, y0: fl - f * 0.04, x1: feet[0] + f * 0.23, y1: fl + f * 0.04 }); }
    }
    if (boxOn) {
      const F = m.boxFrame(), b = m.box.bounds(F), r = m.box.rect(F);
      take({ x0: b.x - 4, y0: b.y - 4, x1: b.x + b.w + 4, y1: b.y + b.h + 4 });
      if (!side) take({ x0: r.x + r.w / 2 - r.w * 0.46, y0: fl - r.w * 0.08, x1: r.x + r.w / 2 + r.w * 0.46, y1: fl + r.w * 0.08 });
    }
    const e = p.effects.bounds();
    if (e) take({ x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h });
    if (!(x1 > x0)) return null;
    const dy = this.duckDy(), pad = 8;
    x0 = Math.max(0, x0 - pad); x1 = Math.min(m.view.w, x1 + pad);
    y0 = Math.max(0, y0 + dy - pad); y1 = Math.min(m.view.h, y1 + dy + pad);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  // the canvases cover only what is drawn: they move by whole device pixels, grow in steps of 64 CSS px and shrink only
  // after two seconds of fitting in less
  private fit(b: Box4 | null, now: number): boolean {
    const dpr = this.p.m.view.dpr, back = Math.min(2, dpr);
    if (!b) b = { x: this.ox, y: this.oy, w: 1, h: 1 };
    const needW = Math.ceil(b.w / 64) * 64, needH = Math.ceil(b.h / 64) * 64;
    let cw = this.cw, ch = this.ch;
    if (needW > cw || needH > ch) { cw = Math.max(cw, needW); ch = Math.max(ch, needH); this.shrinkSince = 0; }
    else if (needW < cw || needH < ch) {
      if (!this.shrinkSince) this.shrinkSince = now;
      else if (now - this.shrinkSince > 2000) { cw = needW; ch = needH; this.shrinkSince = 0; }
    } else this.shrinkSince = 0;
    let ox = this.ox, oy = this.oy;
    const inside = b.x >= ox + 1 && b.y >= oy + 1 && b.x + b.w <= ox + cw - 1 && b.y + b.h <= oy + ch - 1;
    if (!inside || cw !== this.cw || ch !== this.ch) {
      ox = Math.floor((b.x - (cw - b.w) / 2) * dpr) / dpr;
      oy = Math.floor((b.y - (ch - b.h) / 2) * dpr) / dpr;
    }
    let moved = false;
    if (cw !== this.cw || ch !== this.ch) {
      for (const c of [this.glc, this.fxc]) {
        c.width = Math.max(1, Math.round(cw * back)); c.height = Math.max(1, Math.round(ch * back));
        c.style.width = `${cw}px`; c.style.height = `${ch}px`;
      }
      this.cw = cw; this.ch = ch;
      moved = true;
    }
    if (ox !== this.ox || oy !== this.oy || moved) {
      const t = `translate(${ox}px,${oy}px)`;
      this.glc.style.transform = t; this.fxc.style.transform = t;
      this.ox = ox; this.oy = oy;
      moved = true;
    }
    return moved;
  }

  /** Did anything on screen move by more than about a quarter device pixel since the last drawn frame? */
  private changed(herOn: boolean): boolean {
    const p = this.p, m = p.m, st = m.st, eps = 0.25 / m.view.dpr;
    if (p.effects.alive || m.box.fading) return true;
    let moved = false;
    if (herOn) {
      const meshes = p.rig.meshes();
      let n = 0;
      for (const mesh of meshes) if (!mesh.over) n += mesh.pos.length;
      if (this.lastPos.length !== n) { this.lastPos = new Float32Array(n); moved = true; }
      let o = 0;
      const last = this.lastPos;
      for (const mesh of meshes) {
        if (mesh.over) continue;
        const pos = mesh.pos;
        for (let i = 0; i < pos.length; i++, o++) {
          if (!moved && Math.abs(pos[i] - last[o]) > eps) moved = true;
          last[o] = pos[i];
        }
      }
    }
    const F = m.boxFrame(), e = st.expr, P = st.paint;
    const sig = [herOn ? 1 : 0, st.alpha, e.base, e.focus, e.happy, e.dismay, e.talk, e.blink, F.ox / eps, F.oy / eps, F.k * 1024 / eps,
      st.box.ang * 4, m.fadeOpen, st.box.show, st.box.queued * 10, P ? (P.lifted ? 2 : 1) : 0, P?.reveal ?? 0, P?.wash ?? 0, st.duck * 100,
      p.input()?.focused ? 1 : 0, st.inFront ? 1 : 0, st.brim.k];
    const last = this.lastSig;
    for (let i = 0; i < sig.length; i++) {
      const tol = i >= 8 && i <= 10 ? 1 : 0.004;
      if (last.length !== sig.length || Math.abs(sig[i] - last[i]) > tol) moved = true;
    }
    if (moved) this.lastSig = sig;
    return moved;
  }

  private draw(herOn: boolean, boxOn: boolean) {
    const p = this.p, m = p.m, st = m.st, gfx = this.gfx!, gl = gfx.gl, T = this.T!, f = m.fig(), fl = m.view.floor;
    const back = this.glc.width / this.cw, dy = this.duckDy();
    gl.viewport(0, 0, this.glc.width, this.glc.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gfx.res = [this.cw, this.ch];
    gfx.off = [this.ox, this.oy - dy];
    if (st.duck > 0.001) {
      // (down behind the input bar's edge: nothing below the line she stood on)
      const cut = clamp((fl - this.oy) * back, 0, this.glc.height);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(0, this.glc.height - Math.round(cut), this.glc.width, Math.round(cut));
    }
    const glow = p.input()?.focused ? 1 : 0;
    const F = m.boxFrame(), b = m.box.rect(F);
    const side = st.mode === 'side';
    // shadows on the floor, hers and the box's: they stay on the floor, fainter and smaller the higher above it what
    // casts them is (in the side she casts none: she is on the screen's edge, off the floor)
    const ground = (x: number, w: number, a: number) => {
      const q = this.quad;
      const y = fl - w * 0.085, h = w * 0.17;
      q.pos.set([x - w / 2, y, x + w / 2, y, x - w / 2, y + h, x + w / 2, y + h]);
      gfx.upload(q); gfx.draw(gfx.p1, q, this.ground!, a);
    };
    if (!side) {
      const feet = m.toScreen(...R.feet), up = herOn ? clamp((fl - feet[1]) / (f * 1.1), 0, 1) : 0;
      if (boxOn) ground(b.x + b.w / 2, b.w * (0.9 - 0.25 * up), 0.3 * (1 - 0.6 * clamp((fl - b.y - b.h) / (f * 0.9), 0, 1)) * st.box.show);
      if (herOn) {
        ground(feet[0], f * 0.44 * (1 - 0.3 * up), 0.42 * (1 - 0.8 * up) * st.alpha);
        ground(feet[0], f * 0.2 * (1 - 0.3 * up), 0.5 * (1 - 0.95 * up) * st.alpha);
      }
    }
    const her = () => { if (herOn) p.rig.draw(gfx, T, st, m.scale(), st.alpha, glow); };
    const box = () => {
      if (!boxOn) return;
      m.box.draw(gfx, F, { ang: st.box.ang, fadeOpen: m.still ? m.fadeOpen : undefined, queued: st.box.queued, paint: st.paint, alpha: st.box.show, glow });
    };
    if (st.inFront) { box(); her(); } else { her(); box(); }
    gl.disable(gl.SCISSOR_TEST);
    // effects on the 2D layer
    const fx = this.fx;
    if (!fx) return;
    fx.setTransform(1, 0, 0, 1, 0, 0);
    fx.clearRect(0, 0, this.fxc.width, this.fxc.height);
    fx.setTransform(back, 0, 0, back, -this.ox * back, -(this.oy - dy) * back);
    if (st.duck > 0.001) { fx.save(); fx.beginPath(); fx.rect(0, -1e5, 1e6, fl + 1e5); fx.clip(); }
    p.effects.draw(fx);
    if (st.duck > 0.001) fx.restore();
  }

  // the still mode: her picture and the shut paintbox placed by the same transforms
  private placeStill(herOn: boolean, boxOn: boolean) {
    const s = this.still!, m = this.p.m, st = m.st;
    const [a, b, c, d, e, f] = m.matrix();
    const dy = this.duckDy();
    s.tia.style.display = herOn ? '' : 'none';
    if (herOn) {
      s.tia.style.transform = `matrix(${a},${b},${c},${d},${e},${f + dy})`;
      s.tia.style.opacity = String(st.alpha);
    }
    s.box.style.display = boxOn ? '' : 'none';
    if (boxOn) {
      const F = m.boxFrame();
      s.box.style.transform = `matrix(${F.k},0,0,${F.k},${F.ox},${F.oy + dy})`;
      s.box.style.opacity = String(st.box.show);
    }
  }

  dispose() {
    this.stop();
    this.gfx?.dispose();
    this.gfx?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gfx = null;
    if (this.still) for (const url of this.still.urls) URL.revokeObjectURL(url);
    this.still = null;
    this.layer.remove();
  }
}
