import { HIT_SHAPES } from './tia.js';
export class Input {
    m;
    launcher;
    hooks;
    herHits;
    boxHits;
    boxPart;
    fine;
    drag = null;
    moved = false;
    suppressClick = false;
    hot = false;
    herT = '';
    boxT = '';
    boxR = '';
    focused = false;
    constructor(m, launcher, hooks, signal) {
        this.m = m;
        this.launcher = launcher;
        this.hooks = hooks;
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
            if (!event.isPrimary || event.button !== 0 || this.drag)
                return;
            const small = this.m.st.away;
            this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch', small };
            this.moved = this.suppressClick = false;
            try {
                launcher.setPointerCapture(event.pointerId);
            }
            catch { /* the pointer is gone already */ }
            this.m.st.ptr = [event.clientX, event.clientY];
            hooks.wake();
        }, { signal });
        launcher.addEventListener('pointermove', event => {
            const d = this.drag;
            if (!d || event.pointerId !== d.pointerId)
                return;
            this.m.st.ptr = [event.clientX, event.clientY];
            if (!this.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < (d.touch ? 10 : 6))
                return;
            if (!this.moved) {
                if (!d.small && !hooks.canDrag())
                    return;
                this.moved = true;
                launcher.classList.add('dragging');
                if (!d.small)
                    hooks.pickUp(d.x, d.y);
            }
            if (d.small)
                hooks.moveSmall(event.clientX);
        }, { signal });
        const end = (event) => {
            const d = this.drag;
            if (!d || event.pointerId !== d.pointerId)
                return;
            this.suppressClick = this.moved || event.type === 'pointercancel';
            this.drag = null;
            launcher.classList.remove('dragging');
            if (this.moved) {
                if (d.small)
                    hooks.dropSmall();
                else
                    hooks.letGo(event.clientX, event.clientY);
            }
            if (launcher.hasPointerCapture(event.pointerId))
                launcher.releasePointerCapture(event.pointerId);
            this.moved = false;
            this.setHot(this.over(event.clientX, event.clientY));
        };
        launcher.addEventListener('pointerup', end, { signal });
        launcher.addEventListener('pointercancel', end, { signal });
        launcher.addEventListener('lostpointercapture', end, { signal });
        launcher.addEventListener('click', event => {
            const ignore = this.suppressClick && event.detail !== 0;
            this.suppressClick = false;
            if (!ignore)
                hooks.click();
        }, { signal });
        launcher.addEventListener('contextmenu', event => event.preventDefault(), { signal });
        const focus = () => {
            let on = false;
            try {
                on = launcher.matches(':focus-visible');
            }
            catch {
                on = false;
            }
            if (on !== this.focused) {
                this.focused = on;
                hooks.wake();
            }
        };
        launcher.addEventListener('focus', focus, { signal });
        launcher.addEventListener('blur', focus, { signal });
        launcher.addEventListener('keyup', focus, { signal });
    }
    get dragging() { return !!this.drag && this.moved; }
    over(x, y) { return this.m.hit(x, y) || this.m.boxHit(x, y); }
    track(event) {
        const m = this.m;
        m.st.ptr = [event.clientX, event.clientY];
        const head = m.toScreen(464, 480);
        if (Math.hypot(event.clientX - head[0], event.clientY - head[1]) < (m.view.narrow ? 260 : 620))
            this.hooks.near();
        if (this.drag || !this.fine.matches)
            return;
        this.setHot(this.over(event.clientX, event.clientY));
    }
    setHot(hot) {
        if (hot === this.hot)
            return;
        this.hot = hot;
        this.launcher.classList.toggle('hot', hot);
    }
    /** The hit parts follow her and the paintbox (written only when they moved). */
    place(showHer, showBox) {
        const m = this.m;
        const [a, b, c, d, e, f] = m.matrix();
        const her = showHer ? `matrix(${a.toFixed(5)},${b.toFixed(5)},${c.toFixed(5)},${d.toFixed(5)},${e.toFixed(1)},${f.toFixed(1)})` : 'none';
        if (her !== this.herT) {
            this.herT = her;
            this.herHits.hidden = !showHer;
            if (showHer)
                this.herHits.style.transform = her;
        }
        const F = m.boxFrame(), r = m.box.hitRect(F, m.st.box.open);
        const box = showBox ? `translate(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px)` : 'none';
        if (box !== this.boxT) {
            this.boxT = box;
            this.boxHits.hidden = !showBox;
            if (showBox)
                this.boxHits.style.transform = box;
        }
        const size = `${Math.round(r.w)}x${Math.round(r.h)}`;
        if (showBox && size !== this.boxR) {
            this.boxR = size;
            this.boxPart.style.cssText = `left:0;top:0;width:${Math.round(r.w)}px;height:${Math.round(r.h)}px`;
        }
    }
}
