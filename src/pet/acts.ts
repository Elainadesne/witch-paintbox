// What she does: out of her corner or side when there is work, back when it is quiet, picked up and let go, reading,
// painting (one sheet on the board, the rest waiting behind it), a failure, and climbing into the paintbox.
import type { PetFault, PetPicture } from '../pet-events.js';
import type { FloorTarget } from '../pet-targets.js';
import { pictureColours } from './box.js';
import type { Effects } from './effects.js';
import type { Gfx } from './gl.js';
import type { Motion } from './motion.js';
import type { Line, Speech } from './speech.js';
import { R } from './tia.js';
import { clamp, lerp, type Box4, type FaultAct, type Sheet, type SideSpot, type Vec } from './state.js';

// how a fault is acted out (the others: the plain puff and shake)
const ACT: Partial<Record<PetFault, FaultAct>> = { reference: 'blank', auth: 'key', quota: 'dry', network: 'thread', timeout: 'nap' };

export interface ActHooks {
  gfx(): Gfx | null;
  wake(): void;
  /** She settled where the player dropped her. */
  settled(): void;
  onAway(away: boolean): void;
  onDrag(): void;
  /** The palette's eight colours, to keep for the next visit. */
  keepPalette(colours: number[][]): void;
}

export interface Work {
  /** The image task drawn now, and how many wait (start or queued). */
  drawing: { id: string; aspect: number } | null;
  waiting: { id: string; aspect: number }[];
}

const PAPER = 832 / 1216;

export class Acts {
  /** Set by the player's let-go: the next settle is hers, and is remembered. */
  private dropped = false;
  private blooming: string | null = null;
  private flights = 0;
  private leaving = false;
  dead = false;
  work: Work = { drawing: null, waiting: [] };

  constructor(private readonly m: Motion, private readonly fx: Effects, private readonly speech: Speech, private readonly hooks: ActHooks) {}

  private get st() { return this.m.st; }

  // ---- moving about --------------------------------------------------------------------------------------------------
  // the edge: out of it in one brisk jump when there is work, and back in when it is quiet again
  hopTo(to: () => Vec, dur: number, lift: number): Promise<void> {
    const st = this.st;
    this.hooks.wake();
    return new Promise(res => {
      if (st.hop) st.hop.res();
      st.hop = { from: [st.P[0], st.P[1]], to, t: this.m.still ? 0 : -0.1, dur, lift, res, up: false, fade: this.m.still };
      if (!this.m.still) st.sqV -= 2.2;
    });
  }

  async out() {
    const st = this.st, m = this.m;
    if (st.away) return;
    if (st.mode === 'side' && st.side) {
      // from the side: in out of sight, and out of the edge again down at the floor (behind the screen she has
      // climbed down), with a jump to where she works
      const spot = st.side;
      st.spot = spot; st.idle = 0;
      if (m.still) { st.alphaTo = 0; await m.until(() => st.alpha < 0.05 || st.mode !== 'side'); }
      else { st.goneTo = 1; this.hooks.wake(); await m.until(() => st.gone > 0.96 || st.mode !== 'side'); }
      if (st.mode !== 'side' || this.dead) return;
      const left = spot.dir === 'L';
      st.mode = 'idle'; st.side = null; st.goneTo = 0; st.gone = 0; st.peek = 0;
      st.piv = [...R.feet]; st.rot = 0; st.rotV = 0;
      st.P = [left ? -m.fig() * 0.45 : m.view.w + m.fig() * 0.45, m.view.floor];
      if (m.still) { st.P = m.home(); st.alphaTo = 1; return; }
      await this.hopTo(() => m.home(), 0.42, 0.14);
      return;
    }
    if (!st.tucked) return;
    st.tucked = false; st.idle = 0;
    await this.hopTo(() => m.home(), 0.34, 0.13);
  }

  // into the side at a height: she comes out of it head first
  enterSide(spot: SideSpot) {
    const st = this.st;
    if (st.hop) { st.hop.res(); st.hop = null; }
    st.mode = 'side'; st.side = spot; st.spot = null; st.dive = null; st.tucked = false;
    st.onLeft = spot.dir === 'L';
    st.gone = 1; st.goneTo = 0; st.peek = 0.4; st.idle = 0; st.rot = this.m.sideBase(); st.rotV = 0; st.sqV += 1.2;
    if (this.m.still) { st.gone = 0; st.alpha = 0; st.alphaTo = 1; }
    if (st.want === 'dismay' && !st.failing) this.m.want('base');
    this.hooks.wake();
    if (this.dropped) { this.dropped = false; this.hooks.settled(); }
  }

  // back to it after work: a hop into the edge down at the floor, and up there she peeks out again
  async backToSide() {
    const st = this.st, m = this.m, spot = st.spot;
    if (!spot) return;
    st.spot = null;
    await this.hopTo(() => [spot.dir === 'R' ? m.view.w + m.fig() * 0.5 : -m.fig() * 0.5, m.view.floor], 0.5, 0.12);
    if (st.mode !== 'idle' || st.away || this.dead) return;
    this.enterSide({ dir: spot.dir, y: m.sideY(spot.y) });
  }

  async tuckIn() {
    const st = this.st;
    if (st.tucked || st.hop || st.mode !== 'idle' || st.away) return;
    st.tucked = true; st.onLeft = false;
    await this.hopTo(() => this.m.tuckP(), 0.55, 0.1);
  }

  // patted too long: flustered, she leans back from the hand and, standing free, hops a step away from it (in her
  // corner, the side or at work she only leans back)
  shy() {
    const st = this.st, m = this.m, before = st.want;
    m.want('dismay');
    this.hooks.wake();
    const away = st.ptr[0] < st.P[0] ? 1 : -1;
    if (!m.still && st.mode === 'idle' && !st.tucked) st.rotV += away * 1.3;
    if (!m.still && st.mode === 'idle' && !st.tucked && !st.hop && !st.casting && !st.reading && !st.menu && !this.leaving) {
      const f = m.fig(), x = clamp(st.P[0] + away * f * 0.22, f * 0.3, m.view.w - f * 0.3);
      void this.hopTo(() => [x, m.view.floor], 0.3, 0.07);
    }
    void (async () => {
      await m.wait(1.1);
      if (st.want === 'dismay' && !st.failing) m.want(before === 'dismay' ? 'base' : before);
    })();
  }

  landed() {
    const st = this.st;
    // (the box keeps to the page's middle side of her)
    if (!st.toEdge && !st.tucked) st.onLeft = st.P[0] < this.m.view.w / 2;
    if (this.dropped) { this.dropped = false; this.hooks.settled(); }
  }

  // picked up: she hangs from where she was taken (by the box in her arms: from her lap), out of the edge (out of the
  // side she hangs from where she was taken and swings down from her quarter turn)
  pickUp(x: number, y: number) {
    const st = this.st, m = this.m;
    const g = m.hit(x, y) ? m.toTex(x, y) : [...R.lap] as Vec;
    if (st.hop) { st.hop.res(); st.hop = null; }
    if (st.mode === 'side') st.rotMax = 1.7;
    st.tucked = false; st.side = null; st.spot = null; st.gone = st.goneTo = 0; st.dive = null;
    st.piv = g; st.P = [x, y]; st.mode = 'drag'; st.rotV = 0; st.alpha = st.alphaTo = 1;
    m.want('dismay');
    this.hooks.onDrag();
    this.speech.say('dragged');
    this.hooks.wake();
  }

  letGo(x: number, y: number) {
    const st = this.st, m = this.m;
    if (st.mode !== 'drag') return;
    st.idle = 0;
    this.dropped = true;
    // let go by the left or right side (low on the right is her corner): she darts into it at that height
    const f = m.fig(), right = x > m.view.w - f * 0.45, left = x < f * 0.45;
    const low = y > m.view.floor - f * 0.6;
    if ((right && !low) || left) {
      st.dive = { t: 0, from: [st.P[0], st.P[1]], spot: { dir: right ? 'R' : 'L', y: m.sideY(y) } };
      st.mode = 'dive';
    } else {
      // let go: back on her feet's pivot without a jump, then she falls to the floor (still: on it at once)
      const feetNow = m.toScreen(...R.feet);
      st.piv = [...R.feet]; st.P = feetNow;
      st.vel = [clamp(st.ptrV[0], -900, 900) * 0.5, clamp(st.ptrV[1], -600, 600) * 0.3];
      st.toEdge = right;                                  // let go low at the right edge: she curls up in her corner
      st.mode = 'fall';
      if (m.still) { st.P = [feetNow[0], m.view.floor]; st.vel = [0, 0]; }
    }
    this.hooks.wake();
  }

  // ---- the text model at work: she reads along the reply, then says what she found ---------------------------------
  async read() {
    const st = this.st;
    if (st.reading) return;
    st.reading = true;
    await this.out();
    if (!st.reading) return;
    this.m.want('focus');
    this.closeBox();
    this.speech.say('reading');
  }

  found(fact: string) {
    const st = this.st;
    st.reading = false; this.m.want('happy');
    this.speech.say('found', st.menu ? '' : fact, false);
    this.m.later(1.8, () => { if (st.want === 'happy' && !st.casting) this.m.want('base'); });
  }

  stopReading() {
    const st = this.st;
    st.reading = false;
    if (st.want === 'focus' && !st.casting) this.m.want('base');
  }

  // ---- the paintbox ------------------------------------------------------------------------------------------------
  /** Shuts it unless something still needs it open. */
  closeBox() {
    const st = this.st;
    if (st.menu || st.paint || st.failing || this.blooming || this.work.drawing || this.work.waiting.length || this.leaving) return;
    st.box.want = 0;
  }

  openBox() {
    const B = this.st.box;
    if (B.want < 0.5) { B.want = 1; B.pop = 1; }
    this.hooks.wake();
  }

  menu(open: boolean) {
    const st = this.st;
    st.menu = open;
    if (open) {
      if (st.away) return;
      this.openBox();
      this.speech.say('menu');
    } else this.closeBox();
  }

  // ---- the work, acted out -----------------------------------------------------------------------------------------
  /** Brings the board in line with the image tasks: the one drawn now on it (washes and motes), the rest behind. */
  async refresh() {
    const st = this.st, W = this.work;
    if (st.away) {
      st.paint = null;
      st.box.crack = W.drawing ? 1 : 0;
      this.hooks.wake();
      return;
    }
    st.box.crack = 0;
    if (this.blooming) return;
    const next = W.drawing ?? W.waiting[0] ?? null;
    if (!next) {
      if (st.paint && !st.paint.lifted) st.paint = null;
      if (!this.flights) this.packUp();
      return;
    }
    let began = false;
    if (!st.casting) {
      st.casting = true;
      await this.out();
      if (this.dead || this.blooming) return;
      began = true;
    }
    // (the work read afresh: a quick fault can end it while she is still on her way out)
    const now = this.work, live = now.drawing ?? now.waiting[0] ?? null;
    if (!live) { this.packUp(); return; }
    if (began) this.m.want('focus');
    this.openBox();
    // (to work: the brim folded up)
    st.brim.up = true;
    if (!st.paint || st.paint.lifted || st.paint.id !== live.id) st.paint = sheet(live.id, live.aspect);
    const washing = now.drawing?.id === live.id;
    st.paint.washing = washing; st.paint.emit = washing;
    this.hooks.wake();
  }

  /** Washes go on while the picture is drawn (the sample's 2.6 s wash, kept moving). */
  step(dt: number) {
    const P = this.st.paint;
    if (P && P.washing && !P.lifted) P.wash += dt / 2.6;
  }

  // the picture is here: the pans take its colours, it blooms in, and for a floor it lifts off the lid as a framed
  // picture and flies to its frame; config and portrait pictures (in the modal panel, over her) are filed back into
  // the paintbox
  async bloom(id: string, floor: boolean, picture: PetPicture) {
    const st = this.st, m = this.m, gfx = this.hooks.gfx();
    if (st.away || !gfx) { void this.refresh(); return; }
    this.blooming = id;
    let bitmap: ImageBitmap | null = null;
    try {
      if (!st.casting) { st.casting = true; await this.out(); }
      this.openBox();
      if (!st.paint || st.paint.lifted || st.paint.id !== id) st.paint = sheet(id, picture.width && picture.height ? picture.width / picture.height : PAPER);
      const P = st.paint;
      P.washing = true; P.emit = true;
      m.want('focus');
      st.brim.up = true;
      bitmap = await decode(picture);
      if (this.dead || st.paint !== P) { bitmap?.close(); return; }
      if (!bitmap) { st.paint = null; return; }
      P.bitmap = bitmap; P.aspect = bitmap.width / bitmap.height;
      P.tex = gfx.texture(bitmap, bitmap.width, bitmap.height);
      const colours = pictureColours(bitmap, bitmap.width, bitmap.height);
      m.box.tint(colours);
      this.hooks.keepPalette(colours);
      const veil = { release: null as (() => void) | null, asked: false };
      const release = () => { const r = veil.release; veil.release = null; try { r?.(); } catch { /* the frame is gone */ } };
      const fly = floor && !m.still;
      await m.tween(m.still ? 0.6 : 1.7, k => {
        P.reveal = k;
        // (the frame hides its picture just before the bloom ends, so it can fly in)
        if (fly && k > 0.9 && !veil.asked) { veil.asked = true; try { veil.release = picture.veil?.() ?? null; } catch { veil.release = null; } }
      });
      P.emit = false; P.washing = false;
      m.want('happy');
      const F = m.boxFrame(), lid = m.box.sheetScreen(F, st.box.ang, P.aspect);
      this.fx.glints(Array.from({ length: 6 }, () => [lerp(lid[0][0], lid[2][0], Math.random()), lerp(lid[0][1], lid[2][1], Math.random())] as Vec), 5, 5, 0.6, 0.07);
      this.speech.say('done');
      await m.wait(m.still ? 0.3 : 0.7);
      if (this.dead) return;
      // it lifts off the lid
      const sheetNow = m.box.sheetScreen(m.boxFrame(), st.box.ang, P.aspect);
      const x0 = Math.min(sheetNow[0][0], sheetNow[3][0]), y0 = Math.min(sheetNow[0][1], sheetNow[1][1]);
      const x1 = Math.max(sheetNow[1][0], sheetNow[2][0]), y1 = Math.max(sheetNow[2][1], sheetNow[3][1]);
      const fw = x1 - x0, fh = fw / P.aspect;
      const from: Box4 = { x: x0, y: (y0 + y1) / 2 - fh / 2, w: fw, h: fh };
      P.lifted = true;
      gfx.free(P.tex); P.tex = null;
      st.paint = null;
      this.blooming = null;
      if (m.still) {
        // (still: no flight; the picture is in its frame already)
        release();
        bitmap.close(); bitmap = null;
        void this.refresh();
        return;
      }
      const img = bitmap;
      bitmap = null;
      this.flights++;
      void this.refresh();
      const dest = floor ? this.destination(picture, from) : null;
      await new Promise<void>(res => {
        let to = dest?.to ?? this.fileBack(from);
        st.fly = {
          img, t: 0, hold: 0.35, dur: 1.25, from, landed: false, fade: !dest?.frame,
          to: () => to,
          near: () => { if (dest?.frame) { const again = dest.again(); if (again) to = again; } },
          onLand: res,
        };
        this.hooks.wake();
      });
      // landed: the frame shows the picture again; a glint at each corner, and she packs up
      release();
      if (dest?.frame) {
        const r = dest.again() ?? dest.to;
        this.fx.glints([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], 7, 3, 0.55, 0.05);
      }
      img.close();
      this.flights--;
      void this.refresh();
    } finally {
      if (this.blooming === id) this.blooming = null;
      bitmap?.close();
    }
  }

  /** Where a floor picture flies: its frame (read now and again just before it lands), else the chat's edge. */
  private destination(picture: PetPicture, from: Box4): { to: Box4; frame: boolean; again(): Box4 | null } | null {
    const read = (): FloorTarget | null => {
      try {
        const t = picture.target();
        return t && 'rect' in t ? t : null;
      } catch { return null; }
    };
    const t = read();
    if (!t) return null;
    const box = (r: DOMRect): Box4 => ({ x: r.left, y: r.top, w: r.width, h: r.height });
    if (t.visible) return { to: box(t.rect), frame: true, again: () => { const n = read(); return n?.visible ? box(n.rect) : null; } };
    // scrolled away: to the top or bottom edge of the chat, where it went
    const chat = t.view ?? document.getElementById('chat')?.getBoundingClientRect();
    const top = Math.max(chat?.top ?? 0, 0), bottom = Math.min(chat?.bottom ?? this.m.view.h, this.m.view.h);
    const w = from.w * 0.6, h = from.h * 0.6;
    const x = clamp(t.rect.left + t.rect.width / 2 - w / 2, chat?.left ?? 0, (chat?.right ?? this.m.view.w) - w);
    return { to: { x, y: t.side === 'above' ? top - h * 0.4 : bottom - h * 0.6, w, h }, frame: false, again: () => null };
  }

  // back into the paintbox: down into its tray, small
  private fileBack(from: Box4): Box4 {
    const r = this.m.boxRect(), w = from.w * 0.3, h = from.h * 0.3;
    return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h * 0.3 - h / 2, w, h };
  }

  // packing up: the box shuts, a breath later her face rests
  private packUp() {
    const st = this.st;
    if (!st.casting) { this.closeBox(); return; }
    void (async () => {
      await this.m.wait(0.9);
      if (this.busyBoard()) return;
      this.closeBox();
      st.brim.up = false;
      if (st.box.want < 0.5) st.box.pop = Math.max(st.box.pop, 0.6);
      await this.m.wait(0.5);
      if (this.busyBoard()) return;
      if (!st.failing && !st.reading) this.m.want('base');
      st.casting = false;
    })();
  }

  private busyBoard() { return !!(this.blooming || this.flights || this.work.drawing || this.work.waiting.length || this.st.paint); }

  /** A sheet taken off the board (cancelled or dropped): the board shows what is left. */
  drop(id: string) {
    const st = this.st;
    if (st.paint && st.paint.id === id && !st.paint.lifted && this.blooming !== id) st.paint = null;
    void this.refresh();
  }

  // a fault, acted out by its kind: no name on the type block for a tag that matches nobody, the key that will not turn,
  // the pans run dry, the thread the paint comes along snapping, asleep over the easel when it took too long (the long
  // wait sent her off, the error wakes her with a start; not asleep yet, she nods off first); then her line with the
  // plugin's own message under it
  async fail(line: Line | null, fact: string, fault?: PetFault) {
    const st = this.st, m = this.m;
    if (st.away) { st.box.shake = 1; this.hooks.wake(); return; }
    const slept = st.asleep && st.easel;
    st.failing = true;
    // (the work is off: the brim comes down now, and does not flip up again as she wakes)
    st.brim.up = false;
    await this.out();
    this.openBox();
    await m.wait(0.3);
    const act: FaultAct = m.still ? 'plain' : (fault && ACT[fault]) || 'plain';
    if (act === 'nap') {
      if (!slept) {
        st.nap = 2.4;
        this.hooks.wake();
        await m.until(() => st.nap <= 0 || this.dead);
      }
      // (awake with a start, she blinks at the easel a moment)
      await m.wait(slept ? 0.7 : 0.35);
    } else if (act === 'plain') {
      this.fx.puff();
      st.box.shake = 1;
    } else {
      st.fault = { act, t: 0, at: null, cues: 0 };
      if (act === 'dry') { m.box.dry(true); this.fx.dust(); }
      this.hooks.wake();
      // (she watches it go wrong first)
      await m.wait(act === 'dry' ? 0.6 : 0.95);
    }
    m.want('dismay');
    this.hooks.wake();
    await m.wait(0.35);
    this.speech.say(line, fact);
    await m.wait(5.3);
    if (act === 'dry') m.box.dry(false);
    st.failing = false;
    this.closeBox();
    if (st.want === 'dismay') m.want(st.casting || st.reading ? 'focus' : 'base');
  }

  // ---- 关闭悬浮球: she climbs into the paintbox, and it rests small on the floor --------------------------------
  get changing() { return this.leaving; }

  private trayPoint(): Vec { const r = this.m.boxRect(); return [r.x + r.w * 0.5, r.y + r.h * 0.42]; }

  async dismiss() {
    const st = this.st, m = this.m;
    if (st.away || this.leaving || st.mode === 'drag') return;
    this.leaving = true;
    st.brim.up = false;
    try {
      this.speech.say('away');
      await this.out();
      if (this.dead) return;
      st.menu = false;
      st.boxHold = m.boxTarget();
      this.openBox();
      await m.wait(m.still ? 0.2 : 0.35);
      st.inFront = true;
      if (m.still) { st.alphaTo = 0; await m.until(() => st.alpha < 0.05); }
      else {
        const hop = this.hopTo(() => { const p = this.trayPoint(); return [p[0], p[1] + 8]; }, 0.5, 0.12);
        void m.tween(0.5, k => { st.shrink = lerp(1, 0.2, k * k); if (k > 0.6) st.alphaTo = 0; });
        await hop;
      }
      st.alpha = st.alphaTo = 0;
      st.away = true; st.inFront = false;
      this.speech.hide();
      st.boxAt = st.boxHold?.[0] ?? st.box.cx;
      st.boxHold = null;
      st.box.want = 0;
      await m.wait(m.still ? 0.2 : 0.45);
      st.box.smallTo = 1;
      if (m.still) st.box.small = 1;
      this.hooks.onAway(true);
      void this.refresh();
    } finally {
      this.leaving = false;
      st.boxHold = null;
      this.hooks.wake();
    }
  }

  async comeBack() {
    const st = this.st, m = this.m;
    if (!st.away || this.leaving) return;
    this.leaving = true;
    try {
      this.hooks.onAway(false);
      const f = m.fig(), side = st.onLeft ? -1 : 1;
      const feetX = clamp(st.boxAt + side * f * 0.68, f * 0.3, m.view.w - f * 0.3);
      st.box.smallTo = 0;
      if (m.still) st.box.small = 0;
      st.box.crack = 0;
      st.mode = 'idle'; st.tucked = false; st.side = null; st.spot = null; st.piv = [...R.feet]; st.rot = 0; st.rotV = 0;
      st.P = [feetX, m.view.floor];
      st.away = false;
      st.shrink = 0.2; st.alpha = st.alphaTo = 0; st.inFront = true;
      st.boxHold = [feetX - side * f * 0.68, m.view.floor - f * 0.26];
      this.hooks.wake();
      await m.wait(m.still ? 0.2 : 0.4);
      this.openBox();
      await m.wait(m.still ? 0.2 : 0.3);
      if (m.still) { st.shrink = 1; st.alphaTo = 1; await m.until(() => st.alpha > 0.95); }
      else {
        st.P = this.trayPoint();
        st.alphaTo = 1;
        const hop = this.hopTo(() => [feetX, m.view.floor], 0.5, 0.16);
        void m.tween(0.5, k => { st.shrink = lerp(0.2, 1, 1 - (1 - k) * (1 - k)); });
        await hop;
        st.shrink = 1;
      }
      st.inFront = false;
      st.boxHold = null;
      st.onLeft = feetX < m.view.w / 2;
      this.leaving = false;
      this.closeBox();
      void this.refresh();
    } finally {
      this.leaving = false;
      st.boxHold = null;
      this.hooks.wake();
    }
  }
}

function sheet(id: string, aspect: number): Sheet {
  return { id, aspect: aspect > 0 && Number.isFinite(aspect) ? aspect : PAPER, tex: null, bitmap: null, reveal: 0, wash: 0, washing: false, emit: false, lifted: false, acc: 0 };
}

/** A copy of the picture at most 1024 px wide (pictures can be 4096 px and 32 MiB). */
async function decode(picture: PetPicture): Promise<ImageBitmap | null> {
  try {
    const width = Math.min(1024, picture.width > 0 ? picture.width : 1024);
    return await createImageBitmap(picture.blob, { resizeWidth: width, resizeQuality: 'high', premultiplyAlpha: 'premultiply' });
  } catch {
    return null;
  }
}
