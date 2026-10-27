// The paintbox: a hollow old book, its cover the lid. GPT drew it shut and open from one camera; the cut gave the book
// without its cover, the cover's outside and its inside, and book_rig.json: the cover is a slab hinged at the back, its
// corners h + r (cos a A + sin a B) + q t (cos a B - sin a A) at either end of the hinge (texture px; r across the cover,
// q through it, a its angle). Each face is flat and the view orthographic, so a face maps affinely from its drawing to
// any angle: the shut drawing's faces until the outside goes edge-on, the open drawing's after.
//
// Everything book-specific lives in this file, behind a small interface (the rest of the pet uses only these):
//   load(url, signal)               the rig and the pictures; upload(gfx) makes the GL side (again after a lost context)
//   SHUT_WIDTH                      the shut box's width as a share of her figure's height
//   frame(cx, cy, w, dx, dy)        where its texture lies on the screen: w the shut box's width, (cx, cy) its middle
//   rect(F) / hitRect(F, open) / bounds(F)   the shut box's rect, what answers a click, all it can cover
//   hinge(B, want, crack, dt)       the open angle's spring (B.ang in degrees, B.av, B.pop, B.open); stepFade(dt) the tint's fade
//   draw(gfx, F, look)              the box with its sheets (look: angle, cross-fade, queued sheets, the live sheet, glow)
//   sheetScreen(F, ang, aspect)     the live sheet's corners on the screen (motes gather there, the picture lifts off)
//   palettePoint(F)                 where paint lifts off (one of the pans)
//   tint(colours)                   the pans take a picture's eight colours (fades in over the old body)
//   crackPoint(F)                   where light shows when it opens a crack
//   shutPicture()                   the shut box as one 2D picture, for the still mode without WebGL2
import { gridMesh, loadBitmap, pixels } from './gl.js';
import { clamp, lerp, sm } from './state.js';
/** The shut box's width as a share of her figure's height (FIG). */
export const SHUT_WIDTH = 0.6;
const DEPTH = 0.76; // the cover is about 1 wide by 0.76 deep, as drawn: (s, r) to lengths
const FILES = { body: 'book_body.webp', out: 'book_cover_out.webp', inside: 'book_cover_in.webp' };
export class Paintbox {
    rig;
    bitmaps = {};
    paintMap = null;
    gfx = null;
    tex = { body: null, prev: null, base: null, out: null, inside: null, paper: null };
    faces = { shut: [], open: [] };
    board = [];
    clip;
    shade;
    sheet = gridMesh(1, 1);
    easel = gridMesh(8, 8);
    quad = gridMesh(1, 1);
    sweep = [0, 0, 1, 1];
    colours = null;
    tinted = null;
    openAngle = 105;
    async load(url, signal) {
        for (const b of Object.values(this.bitmaps))
            b?.close();
        this.bitmaps = {};
        const [rig, body, out, inside, paint] = await Promise.all([
            fetch(url('book_rig.json'), { signal }).then(r => { if (!r.ok)
                throw new Error('book_rig.json'); return r.json(); }),
            loadBitmap(url(FILES.body), signal), loadBitmap(url(FILES.out), signal), loadBitmap(url(FILES.inside), signal),
            loadBitmap(url('book_paint.webp'), signal, true),
        ]);
        this.rig = rig;
        this.openAngle = rig.open;
        this.bitmaps = { body, out, inside };
        if (!this.paintMap) {
            // the pans' map stays on the CPU: red the pan, green how much paint
            const d = pixels(paint, paint.width, paint.height), n = paint.width * paint.height;
            const pan = new Int8Array(n), k = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                pan[i] = Math.round(d[i * 4] / 28) - 1;
                k[i] = (d[i * 4 + 1] / 255) * 0.9;
            }
            this.paintMap = { pan, k };
        }
        paint.close();
        // all it can cover: the body, and the cover at every angle of its swing
        const pts = [];
        for (let a = 0; a <= rig.open + 5; a += 5)
            for (const s of [0, 1])
                for (const r of [0, 1])
                    for (const q of [0, 1])
                        pts.push(this.rigAt(a, s, r, q));
        const [cx0, cy0, cx1, cy1] = rig.closed, [ox0, oy0, ox1, oy1] = rig.openBox;
        this.sweep = [Math.min(cx0, ox0, ...pts.map(p => p[0])), Math.min(cy0, oy0, ...pts.map(p => p[1])),
            Math.max(cx1, ox1, ...pts.map(p => p[0])), Math.max(cy1, oy1, ...pts.map(p => p[1]))];
    }
    /** The GL side, from the loaded pictures (they are let go after; the body's stays for the tint). */
    upload(gfx, paper) {
        this.gfx = gfx;
        const b = this.bitmaps;
        if (!b.body || !b.out || !b.inside)
            throw new Error('paintbox not loaded');
        this.tex.base = gfx.texture(b.body, b.body.width, b.body.height);
        this.tex.out = gfx.texture(b.out, b.out.width, b.out.height);
        this.tex.inside = gfx.texture(b.inside, b.inside.width, b.inside.height);
        this.tex.paper = gfx.texture(paper, paper.width, paper.height);
        b.out.close();
        b.inside.close();
        delete b.out;
        delete b.inside;
        this.tex.body = this.tex.base;
        this.tex.prev = null;
        if (this.tinted)
            this.tex.body = gfx.texture(this.tinted, this.tinted.width, this.tinted.height);
        for (const m of [...this.faces.shut, ...this.faces.open, this.clip, this.shade])
            if (m)
                gfx.remove(m);
        const sh = this.rig.shut, op = this.rig.open_faces;
        this.faces.shut = [sh.left, sh.front, sh.out].map(f => gfx.add(this.faceMesh(f.uv, f.rig)));
        this.faces.open = [op.left, op.top, op.in].map(f => gfx.add(this.faceMesh(f.uv, f.rig)));
        this.board = this.rig.board.map(p => this.insideAt(p));
        this.clip = gfx.add(this.faceMesh(this.rig.clip, this.rig.clip.map(p => [...this.insideAt(p), -0.02]), 2));
        this.shade = gfx.add(this.faceMesh(this.rig.trayShade, this.rig.trayShade.map(() => [0, 0, 0]), 1));
        for (const m of [this.sheet, this.easel, this.quad])
            gfx.add(m);
    }
    rigAt(a, s, r, q) {
        const RIG = this.rig;
        const c = Math.cos(a * Math.PI / 180), n = Math.sin(a * Math.PI / 180), t = RIG.t;
        let x = 0, y = 0;
        for (let e = 0; e < 2; e++) {
            const w = e ? s : 1 - s, h = RIG.h[e], A = RIG.A[e], B = RIG.B[e];
            x += w * (h[0] + r * (c * A[0] + n * B[0]) + q * t * (c * B[0] - n * A[0]));
            y += w * (h[1] + r * (c * A[1] + n * B[1]) + q * t * (c * B[1] - n * A[1]));
        }
        return [x, y];
    }
    // (s, r) on the cover's inside for a point of the open drawing
    insideAt(p) {
        let s = 0.5, r = 0.5;
        const open = this.rig.open;
        for (let i = 0; i < 12; i++) {
            const f = this.rigAt(open, s, r, 0), fs = this.rigAt(open, s + 1e-3, r, 0), fr = this.rigAt(open, s, r + 1e-3, 0);
            const a = (fs[0] - f[0]) * 1e3, b = (fr[0] - f[0]) * 1e3, c = (fs[1] - f[1]) * 1e3, d = (fr[1] - f[1]) * 1e3;
            const dx = p[0] - f[0], dy = p[1] - f[1], det = a * d - b * c;
            s += (d * dx - b * dy) / det;
            r += (a * dy - c * dx) / det;
        }
        return [s, r];
    }
    // a face as a mesh: its corners in the texture and on the rig (s, r, q), filled in between
    faceMesh(uvC, rigC, cols = 4) {
        const m = gridMesh(cols, cols);
        m.par = new Float32Array(m.n * 3);
        const bl = (C, u, v, i) => lerp(lerp(C[0][i], C[1][i], u), lerp(C[3][i], C[2][i], u), v);
        for (let k = 0; k < m.n; k++) {
            const u = m.uv[k * 2], v = m.uv[k * 2 + 1];
            for (let i = 0; i < 3; i++)
                m.par[k * 3 + i] = bl(rigC, u, v, i);
            m.uv[k * 2] = bl(uvC, u, v, 0) / this.rig.size[0];
            m.uv[k * 2 + 1] = bl(uvC, u, v, 1) / this.rig.size[1];
        }
        return m;
    }
    placeRig(m, a, F) {
        const par = m.par;
        for (let k = 0; k < m.n; k++) {
            const p = this.rigAt(a, par[k * 3], par[k * 3 + 1], par[k * 3 + 2]);
            m.pos[k * 2] = F.ox + p[0] * F.k;
            m.pos[k * 2 + 1] = F.oy + p[1] * F.k;
        }
        this.gfx.upload(m);
    }
    // a mesh spread over four screen points (TL, TR, BR, BL)
    setPts(m, C) {
        for (let k = 0; k < m.n; k++) {
            const u = (k % (m.cols + 1)) / m.cols, v = Math.floor(k / (m.cols + 1)) / m.rows;
            m.pos[k * 2] = lerp(lerp(C[0][0], C[1][0], u), lerp(C[3][0], C[2][0], u), v);
            m.pos[k * 2 + 1] = lerp(lerp(C[0][1], C[1][1], u), lerp(C[3][1], C[2][1], u), v);
        }
        this.gfx.upload(m);
    }
    setQuad(m, x, y, w, h) {
        for (let k = 0; k < m.n; k++) {
            const u = m.uv[k * 2], v = m.uv[k * 2 + 1];
            m.pos[k * 2] = x + u * w;
            m.pos[k * 2 + 1] = y + v * h;
        }
        this.gfx.upload(m);
    }
    frame(cx, cy, w, dx = 0, dy = 0) {
        const cb = this.rig.closed;
        const k = w / (cb[2] - cb[0]);
        return { k, ox: cx - (cb[0] + cb[2]) / 2 * k + dx, oy: cy - (cb[1] + cb[3]) / 2 * k + dy };
    }
    /** The shut box's height for a width (its shape as drawn). */
    heightFor(w) { const cb = this.rig.closed; return w * (cb[3] - cb[1]) / (cb[2] - cb[0]); }
    // the shut book's place on the screen (the menu and a click go by it)
    rect(F) {
        const cb = this.rig.closed;
        return { x: F.ox + cb[0] * F.k, y: F.oy + cb[1] * F.k, w: (cb[2] - cb[0]) * F.k, h: (cb[3] - cb[1]) * F.k };
    }
    // it answers a click as she does, shut or standing open
    hitRect(F, open) {
        const b = open > 0.5 ? this.rig.openBox : this.rig.closed;
        return { x: F.ox + b[0] * F.k, y: F.oy + b[1] * F.k, w: (b[2] - b[0]) * F.k, h: (b[3] - b[1]) * F.k };
    }
    bounds(F) {
        const [x0, y0, x1, y1] = this.sweep;
        return { x: F.ox + x0 * F.k, y: F.oy + y0 * F.k, w: (x1 - x0) * F.k, h: (y1 - y0) * F.k };
    }
    // its cover swings on the hinge, a little past its rest when flung open (a strap inside stops it) and with a small
    // bounce when it drops shut; crack: a few degrees open (while it works on its own)
    hinge(B, want, crack, dt) {
        const open = this.rig.open, to = want > 0.5 ? open : crack > 0.5 ? 14 : 0;
        B.av += (120 * (to - B.ang) - 12 * B.av) * dt;
        B.ang += B.av * dt;
        if (B.ang > open + 5) {
            B.ang = open + 5;
            B.av *= -0.3;
        }
        if (B.ang < 0) {
            if (B.av < -120)
                B.pop = Math.max(B.pop, 0.35);
            B.ang = 0;
            B.av *= -0.22;
        }
        B.open = clamp(B.ang / open, 0, 1);
    }
    // the sheet on the drawing board, under the clip: as tall as fits and as wide as the picture's shape asks; the
    // ones waiting their turn lie behind it, a little askew; inset takes the picture's margin off ((s, r) corners)
    sheetCorners(aspect, i = 0, inset = 0) {
        const [tl, tr, br, bl] = this.board;
        const s0 = (tl[0] + bl[0]) / 2, s1 = (tr[0] + br[0]) / 2, rT = (tl[1] + tr[1]) / 2, rB = (bl[1] + br[1]) / 2;
        const bw = s1 - s0, bh = (rT - rB) * DEPTH;
        let h = bh * 0.86, w = h * aspect;
        if (w > bw * 0.9) {
            w = bw * 0.9;
            h = w / aspect;
        }
        const side = i % 2 ? 1 : -1, ang = i ? side * 0.03 * Math.min(i, 3) : 0;
        const cx = (s0 + s1) / 2 + (i ? side * 0.01 * i : 0), cy = rT * DEPTH - bh * 0.045 - h / 2 - i * 0.004;
        const c = Math.cos(ang), n = Math.sin(ang), m = inset * w;
        return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => {
            const x = sx * (w / 2 - m), y = sy * (h / 2 - m);
            return [cx + x * c - y * n, (cy + x * n + y * c) / DEPTH];
        });
    }
    sheetScreen(F, ang, aspect) {
        return this.sheetCorners(aspect).map(([s, r]) => this.onScreen(F, this.rigAt(ang, s, r, -0.01)));
    }
    onScreen(F, p) { return [F.ox + p[0] * F.k, F.oy + p[1] * F.k]; }
    palettePoint(F) {
        const p = this.rig.pans[(Math.random() * this.rig.pans.length) | 0];
        return this.onScreen(F, [p[0] + (Math.random() - 0.5) * 60, p[1] + (Math.random() - 0.5) * 26]);
    }
    crackPoint(F) { return this.onScreen(F, this.rigAt(0, 0.5, 1, 0.5)); }
    drawSheets(F, a, look, alpha) {
        const gfx = this.gfx, T = this.tex, P = look.paint, live = !!P && !P.lifted, n = Math.min(4, look.queued), asp = P?.aspect ?? 0.684;
        if (!live && !n)
            return;
        const scr = (C, q) => C.map(([s, r]) => this.onScreen(F, this.rigAt(a, s, r, q)));
        const sheet = (C, blank) => {
            this.setPts(this.sheet, C.map(([x, y]) => [x + 1.2, y + 2]));
            gfx.draw(gfx.p1, this.sheet, T.paper, 0.25 * alpha, { tint: [0.1, 0.06, 0.02], mix: 1 });
            this.setPts(this.sheet, C);
            gfx.draw(gfx.p1, this.sheet, T.paper, alpha, blank ? { tint: [0, 0, 0], mix: 0.04 } : undefined);
        };
        for (let i = n + (live ? 0 : -1); i >= (live ? 1 : 0); i--)
            sheet(scr(this.sheetCorners(asp, i), -0.01 + i * 0.002), true);
        if (live) {
            sheet(scr(this.sheetCorners(asp, 0), -0.01), false);
            this.setPts(this.easel, scr(this.sheetCorners(asp, 0, 0.06), -0.012));
            gfx.draw(gfx.p2, this.easel, P.tex ?? T.paper, alpha, { reveal: P.tex ? P.reveal : 0, wash: P.wash });
        }
        this.placeRig(this.clip, a, F);
        gfx.draw(gfx.p1, this.clip, T.inside, alpha);
    }
    // the book: its body, and the cover on its hinge (past upright it stands behind the pages). While the cover is low
    // over the tray the tray lies in its shade; the big face darkens as it turns from the light (the outside towards
    // the back, the inside down over the tray); on the inside the sheet she paints on
    draw(gfx, F, look) {
        const RIG = this.rig, T = this.tex, a = look.ang, alpha = look.alpha;
        const fade = this.fadeShare();
        const drawBody = (al, glow) => {
            this.setQuad(this.quad, F.ox, F.oy, RIG.size[0] * F.k, RIG.size[1] * F.k);
            if (glow) {
                gfx.draw(gfx.p1, this.quad, T.body, al, { tint: [0.96, 0.8, 0.46], mix: 1 });
                return;
            }
            if (fade < 1 && T.prev) {
                gfx.draw(gfx.p1, this.quad, T.prev, al);
                gfx.draw(gfx.p1, this.quad, T.body, fade * al);
            }
            else
                gfx.draw(gfx.p1, this.quad, T.body, al);
            const shade = 0.55 * (1 - sm(RIG.edgeOn * 0.5, RIG.open * 0.92, a));
            if (look.fadeOpen === undefined && shade > 0.01 && a > 0.3) {
                this.setPts(this.shade, RIG.trayShade.map(p => this.onScreen(F, p)));
                gfx.draw(gfx.p1, this.shade, T.body, shade * al, { tint: [0.1, 0.06, 0.03], mix: 1 });
            }
        };
        const drawCover = (ang, al, glow) => {
            const shut = ang < RIG.edgeOn, faces = shut ? this.faces.shut : this.faces.open, tx = shut ? T.out : T.inside;
            const dim = shut ? 0.3 * ang / RIG.edgeOn : 0.3 * clamp((RIG.open - ang) / (RIG.open - RIG.edgeOn), 0, 1);
            faces.forEach((m, i) => {
                this.placeRig(m, ang, F);
                gfx.draw(gfx.p1, m, tx, al, glow ? { tint: [0.96, 0.8, 0.46], mix: 1 } : i === 2 && dim > 0.004 ? { tint: [0, 0, 0], mix: dim } : undefined);
            });
            if (!shut && !glow)
                this.drawSheets(F, ang, look, al);
        };
        if (look.glow > 0.01) {
            const off = [gfx.off[0], gfx.off[1]], r = 3;
            for (let i = 0; i < 8; i++) {
                const t = i * Math.PI / 4;
                gfx.off = [off[0] - Math.cos(t) * r, off[1] - Math.sin(t) * r];
                const g = 0.34 * look.glow * alpha;
                if (look.fadeOpen === undefined) {
                    if (a > 90) {
                        drawCover(a, g, true);
                        drawBody(g, true);
                    }
                    else {
                        drawBody(g, true);
                        drawCover(a, g, true);
                    }
                }
                else
                    drawBody(g, true);
            }
            gfx.off = off;
        }
        if (look.fadeOpen !== undefined) {
            // (still: the open state fades in over the shut one, no hinge)
            const o = look.fadeOpen;
            if (o > 0.004)
                drawCover(RIG.open, o * alpha);
            drawBody(alpha);
            if (o < 0.996)
                drawCover(0, (1 - o) * alpha);
            return;
        }
        if (a > 90) {
            drawCover(a, alpha);
            drawBody(alpha);
        }
        else {
            drawBody(alpha);
            drawCover(a, alpha);
        }
    }
    fadeIn = 1;
    /** The tinted body's share while it fades in over the old one. */
    fadeShare() { return this.fadeIn; }
    stepFade(dt) { this.fadeIn = Math.min(1, this.fadeIn + dt * 1.4); }
    get fading() { return this.fadeIn < 1; }
    // the paint in the pans takes the picture's colours, baked into a copy of the book's body that fades in over the old
    // one (at once when it comes back from the last visit)
    tint(cols, fade = true) {
        const body = this.bitmaps.body, map = this.paintMap;
        if (!body || !map || cols.length < 8)
            return;
        const W = body.width, H = body.height;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(body, 0, 0);
        const id = x.getImageData(0, 0, W, H), d = id.data;
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            const pan = map.pan[p], k = map.k[p];
            if (pan < 0 || pan > 7 || k <= 0 || !d[i + 3])
                continue;
            const q = cols[pan], l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], lq = Math.max(30, 0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2]);
            for (let ch = 0; ch < 3; ch++)
                d[i + ch] = d[i + ch] * (1 - k) + Math.min(255, q[ch] * l / lq) * k;
        }
        x.putImageData(id, 0, 0);
        this.colours = cols.map(q => q.slice());
        this.tinted = c;
        const gfx = this.gfx;
        if (!gfx)
            return;
        const T = this.tex;
        if (T.prev && T.prev !== T.base)
            gfx.free(T.prev);
        T.prev = fade ? T.body : null;
        if (!fade && T.body && T.body !== T.base)
            gfx.free(T.body);
        T.body = gfx.texture(c, W, H);
        this.fadeIn = fade ? 0 : 1;
    }
    get palette() { return this.colours; }
    /** The shut box as one picture (the 1024 px frame), for the still mode: the body, then the shut cover's faces. */
    shutPicture() {
        const body = this.bitmaps.body, out = this.bitmaps.out;
        if (!body || !out)
            return null;
        const S = this.rig.size, c = document.createElement('canvas');
        c.width = S[0];
        c.height = S[1];
        const x = c.getContext('2d');
        if (!x)
            return null;
        x.drawImage(body, 0, 0);
        const sh = this.rig.shut;
        for (const f of [sh.left, sh.front, sh.out]) {
            const P = f.rig.map(([s, r, q]) => this.rigAt(0, s, r, q)), U = f.uv;
            // the affine map that takes the face's drawing (corners 0, 1, 3) to its place
            const ux = U[1][0] - U[0][0], uy = U[1][1] - U[0][1], vx = U[3][0] - U[0][0], vy = U[3][1] - U[0][1];
            const px = P[1][0] - P[0][0], py = P[1][1] - P[0][1], qx = P[3][0] - P[0][0], qy = P[3][1] - P[0][1];
            const det = ux * vy - uy * vx;
            if (!det)
                continue;
            const a = (px * vy - qx * uy) / det, b = (py * vy - qy * uy) / det, cc = (qx * ux - px * vx) / det, dd = (qy * ux - py * vx) / det;
            x.save();
            x.beginPath();
            P.forEach(([X, Y], i) => (i ? x.lineTo(X, Y) : x.moveTo(X, Y)));
            x.closePath();
            x.clip();
            x.setTransform(a, b, cc, dd, P[0][0] - a * U[0][0] - cc * U[0][1], P[0][1] - b * U[0][0] - dd * U[0][1]);
            x.drawImage(out, 0, 0);
            x.restore();
        }
        return c;
    }
    /** Lost context: the GL names are gone; the pictures must be loaded again before upload. */
    lose() {
        this.gfx = null;
        this.tex = { body: null, prev: null, base: null, out: null, inside: null, paper: null };
    }
    dispose() {
        for (const b of Object.values(this.bitmaps))
            b?.close();
        this.bitmaps = {};
        this.gfx = null;
        this.tinted = null;
    }
}
/** Eight colours from a small copy of a picture (k-means), ordered by hue. */
export function pictureColours(img, w, h) {
    const d = pixels(img, w, h, 40, 40), px = [];
    for (let i = 0; i < d.length; i += 4)
        px.push([d[i], d[i + 1], d[i + 2]]);
    let cs = Array.from({ length: 8 }, (_, i) => px[Math.floor((i + 0.5) * px.length / 8)].slice());
    for (let it = 0; it < 8; it++) {
        const sum = cs.map(() => [0, 0, 0, 0]);
        for (const p of px) {
            let bi = 0, bd = Infinity;
            cs.forEach((q, j) => { const e = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; if (e < bd) {
                bd = e;
                bi = j;
            } });
            const s = sum[bi];
            s[0] += p[0];
            s[1] += p[1];
            s[2] += p[2];
            s[3]++;
        }
        cs = cs.map((q, j) => (sum[j][3] ? sum[j].slice(0, 3).map(v => v / sum[j][3]) : q));
    }
    const hue = ([r, g, b]) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn < 18)
            return 400 + mx;
        const hh = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
        return ((hh * 60) + 360 + 30) % 360;
    };
    return cs.sort((a, b) => hue(a) - hue(b));
}
