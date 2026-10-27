// The plugin's own launcher button stays the hit shape (aria, focus, keyboard and the menu's outside-click test rely
// on it): emptied to a 0x0 box, with hit parts inside it that follow her and the paintbox. Fine pointers turn the parts
// on only over her opaque pixels or the paintbox; touch keeps them on. Drag as the old ball's (launcher.ts).
import type { Motion } from './motion.js';
import { HIT_SHAPES } from './tia.js';

export interface InputHooks {
  pickUp(x: number, y: number): void;
  letGo(x: number, y: number): void;
  click(): void;
  /** Pointer moved near her (she wants a quicker frame rate for a moment). */
  near(): void;
  wake(): void;
  /** Can she be taken up now (not while climbing into or out of the paintbox). */
  canDrag(): boolean;
  moveSmall(x: number): void;
  dropSmall(): void;
}

export class Input {
  readonly herHits: HTMLSpanElement;
  readonly boxHits: HTMLSpanElement;
  private readonly boxPart: HTMLSpanElement;
  private readonly fine: MediaQueryList;
  private drag: { pointerId: number; x: number; y: number; touch: boolean; small: boolean } | null = null;
  private moved = false;
  private suppressClick = false;
  private hot = false;
  private herT = '';
  private boxT = '';
  private boxR = '';
  focused = false;

  constructor(private readonly m: Motion, private readonly launcher: HTMLButtonElement, private readonly hooks: InputHooks, signal: AbortSignal) {
    this.fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    launcher.classList.toggle('touch', !this.fine.matches);
    this.fine.addEventListener('change', () => launcher.classList.toggle('touch', !this.fine.matches), { signal });
    this.herHits = document.createElement('span');
    this.herHits.className = 'pet-hits';
    for (const [x, y, w, h] of HIT_SHAPES) {
      const part = document.createElement('span');
      part.className = 'pet-hit';
      part.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      this.herHits.append(part);
    }
    this.boxHits = document.createElement('span');
    this.boxHits.className = 'pet-hits';
    this.boxPart = document.createElement('span');
    this.boxPart.className = 'pet-hit';
    this.boxHits.append(this.boxPart);
    launcher.append(this.herHits, this.boxHits);

    window.addEventListener('pointermove', event => this.track(event), { passive: true, capture: true, signal });
    launcher.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || this.drag) return;
      const small = this.m.st.away;
      this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch', small };
      this.moved = this.suppressClick = false;
      try { launcher.setPointerCapture(event.pointerId); } catch { /* the pointer is gone already */ }
      this.m.st.ptr = [event.clientX, event.clientY];
      hooks.wake();
    }, { signal });
    launcher.addEventListener('pointermove', event => {
      const d = this.drag;
      if (!d || event.pointerId !== d.pointerId) return;
      this.m.st.ptr = [event.clientX, event.clientY];
      if (!this.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < (d.touch ? 10 : 6)) return;
      if (!this.moved) {
        if (!d.small && !hooks.canDrag()) return;
        this.moved = true;
        launcher.classList.add('dragging');
        if (!d.small) hooks.pickUp(d.x, d.y);
      }
      if (d.small) hooks.moveSmall(event.clientX);
    }, { signal });
    const end = (event: PointerEvent) => {
      const d = this.drag;
      if (!d || event.pointerId !== d.pointerId) return;
      this.suppressClick = this.moved || event.type === 'pointercancel';
      this.drag = null;
      launcher.classList.remove('dragging');
      if (this.moved) { if (d.small) hooks.dropSmall(); else hooks.letGo(event.clientX, event.clientY); }
      if (launcher.hasPointerCapture(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
      this.moved = false;
      this.setHot(this.over(event.clientX, event.clientY));
    };
    launcher.addEventListener('pointerup', end, { signal });
    launcher.addEventListener('pointercancel', end, { signal });
    launcher.addEventListener('lostpointercapture', end, { signal });
    launcher.addEventListener('click', event => {
      const ignore = this.suppressClick && event.detail !== 0;
      this.suppressClick = false;
      if (!ignore) hooks.click();
    }, { signal });
    launcher.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    const focus = () => {
      let on = false;
      try { on = launcher.matches(':focus-visible'); } catch { on = false; }
      if (on !== this.focused) { this.focused = on; hooks.wake(); }
    };
    launcher.addEventListener('focus', focus, { signal });
    launcher.addEventListener('blur', focus, { signal });
    launcher.addEventListener('keyup', focus, { signal });
  }

  get dragging() { return !!this.drag && this.moved; }

  private over(x: number, y: number) { return this.m.hit(x, y) || this.m.boxHit(x, y); }

  private track(event: PointerEvent) {
    const m = this.m;
    m.st.ptr = [event.clientX, event.clientY];
    const head = m.toScreen(464, 480);
    if (Math.hypot(event.clientX - head[0], event.clientY - head[1]) < (m.view.narrow ? 260 : 620)) this.hooks.near();
    if (this.drag || !this.fine.matches) return;
    this.setHot(this.over(event.clientX, event.clientY));
  }

  private setHot(hot: boolean) {
    if (hot === this.hot) return;
    this.hot = hot;
    this.launcher.classList.toggle('hot', hot);
  }

  /** The hit parts follow her and the paintbox (written only when they moved). */
  place(showHer: boolean, showBox: boolean) {
    const m = this.m;
    const [a, b, c, d, e, f] = m.matrix();
    const her = showHer ? `matrix(${a.toFixed(5)},${b.toFixed(5)},${c.toFixed(5)},${d.toFixed(5)},${e.toFixed(1)},${f.toFixed(1)})` : 'none';
    if (her !== this.herT) {
      this.herT = her;
      this.herHits.hidden = !showHer;
      if (showHer) this.herHits.style.transform = her;
    }
    const F = m.boxFrame(), r = m.box.hitRect(F, m.st.box.open);
    const box = showBox ? `translate(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px)` : 'none';
    if (box !== this.boxT) {
      this.boxT = box;
      this.boxHits.hidden = !showBox;
      if (showBox) this.boxHits.style.transform = box;
    }
    const size = `${Math.round(r.w)}x${Math.round(r.h)}`;
    if (showBox && size !== this.boxR) {
      this.boxR = size;
      this.boxPart.style.cssText = `left:0;top:0;width:${Math.round(r.w)}px;height:${Math.round(r.h)}px`;
    }
  }
}
