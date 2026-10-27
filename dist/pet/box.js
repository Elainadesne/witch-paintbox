// The paintbox: the old walnut box, redrawn shut and open from one camera. Shut it is a thick old book; open, its lid
// stands as an easel over the tray of pans, the brass type blocks racked on its inside, a folding stay propping it from
// behind with its feet in a drawer that slides out at the back. The cut gave it as layers (each cropped: its corner o
// and size wh in the frame, texture px) and box_rig.json: the lid is a slab on a hinge at the back, its corners
// h(a) + r (cos a A + sin a B) + q t (cos a B - sin a A) at either end of the hinge (r across the lid, q through it, a its
// angle; the drawings have a little perspective, so the hinge h runs from the rim, shut, to where the open drawing
// stands the lid). A face maps from its drawing to any angle: the shut drawing's faces until the outside goes edge-on,
// the open drawing's after. The stay is a rigid strut from the lid's back to the drawer's floor, so the lid coming down
// pushes the drawer in (its travel, per degree, is in the rig); lower still the stay folds away into the lid.
//
// Everything box-specific lives in this file, behind a small interface (the rest of the pet uses only these):
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
//   rackPoint(F, ang) / keyPoint(F) a type block in the lid's rack, the keyhole under the clasp (the faults' acts)
//   dry(on)                         the pans run dry, or take their paint back
//   shutPicture()                   the shut box as one 2D picture, for the still mode without WebGL2
import { gridMesh, loadBitmap, pixels } from './gl.js';
import { clamp, lerp, sm } from './state.js';
/** The shut box's width as a share of her figure's height (FIG). */
export const SHUT_WIDTH = 0.385;
const DEPTH = 0.8; // the lid is about 1 wide by 0.8 deep: (s, r) to lengths
const FILES = { body: 'box_body.webp', lidOut: 'box_lid_out.webp', lidIn: 'box_lid_in.webp', drawer: 'box_drawer.webp', stay: 'box_stay.webp' };
const ease = (k) => k * k * (3 - 2 * k);
const GLOW = { tint: [0.96, 0.8, 0.46], mix: 1 };
// (frame px, as drawn open) a type block a little right of the middle of the rack's upper row; the keyhole on the
// front under the clasp's knob; the pans' porcelain, bare
const RACK = [632, 377];
const KEYHOLE = [587, 868];
const PORCELAIN = [238, 233, 222];
export class Paintbox {
    rig;
    bitmaps = {};
    paintMap = null;
    gfx = null;
    tex = { body: null, prev: null, base: null, lidOut: null, lidIn: null, drawer: null, stay: null, paper: null };
    faces = { shut: [], open: [] };
    board = [];
    shade;
    stayMesh;
    sheet = gridMesh(1, 1);
    easel = gridMesh(8, 8);
    bodyQuad = gridMesh(1, 1);
    drawerQuad = gridMesh(1, 1);
    sweep = [0, 0, 1, 1];
    colours = null;
    tinted = null;
    rack = [0.5, 0.2];
    // the pans' colours from before they ran dry (null: as drawn); undefined while they have paint
    wet = undefined;
    openAngle = 105;
    async load(url, signal) {
        for (const b of Object.values(this.bitmaps))
            b?.close();
        this.bitmaps = {};
        const [rig, body, lidOut, lidIn, drawer, stay, paint] = await Promise.all([
            fetch(url('box_rig.json'), { signal }).then(r => { if (!r.ok)
                throw new Error('box_rig.json'); return r.json(); }),
            loadBitmap(url(FILES.body), signal), loadBitmap(url(FILES.lidOut), signal), loadBitmap(url(FILES.lidIn), signal),
            loadBitmap(url(FILES.drawer), signal), loadBitmap(url(FILES.stay), signal),
            loadBitmap(url('box_paint.webp'), signal, true),
        ]);
        this.rig = rig;
        this.openAngle = rig.open;
        this.bitmaps = { body, lidOut, lidIn, drawer, stay };
        if (!this.paintMap) {
            // the pans' map stays on the CPU (over the body's layer): red the pan, green how much paint
            const d = pixels(paint, paint.width, paint.height), n = paint.width * paint.height;
            const pan = new Int8Array(n), k = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                pan[i] = Math.round(d[i * 4] / 28) - 1;
                k[i] = (d[i * 4 + 1] / 255) * 0.9;
            }
            this.paintMap = { pan, k };
        }
        paint.close();
        // all it can cover: the body, the drawer as far out as it goes, the lid at every angle of its swing, the stay
        const pts = [];
        for (let a = 0; a <= rig.open + 5; a += 5) {
            for (const s of [0, 1])
                for (const r of [0, 1])
                    for (const q of [0, 1])
                        pts.push(this.rigAt(a, s, r, q));
            if (a >= rig.stay.fold[0])
                pts.push(...this.stayCorners(a));
        }
        const L = rig.layers.drawer;
        pts.push(L.o, [L.o[0] + L.wh[0], L.o[1] + L.wh[1]]);
        const [cx0, cy0, cx1, cy1] = rig.closed, [ox0, oy0, ox1, oy1] = rig.openBox;
        this.sweep = [Math.min(cx0, ox0, ...pts.map(p => p[0])), Math.min(cy0, oy0, ...pts.map(p => p[1])),
            Math.max(cx1, ox1, ...pts.map(p => p[0])), Math.max(cy1, oy1, ...pts.map(p => p[1]))];
    }
    /** The GL side, from the loaded pictures (they are let go after; the body's stays for the tint). */
    upload(gfx, paper) {
        this.gfx = gfx;
        const b = this.bitmaps, L = this.rig.layers;
        if (!b.body || !b.lidOut || !b.lidIn || !b.drawer || !b.stay)
            throw new Error('paintbox not loaded');
        this.tex.base = gfx.texture(b.body, b.body.width, b.body.height);
        this.tex.lidOut = gfx.texture(b.lidOut, b.lidOut.width, b.lidOut.height);
        this.tex.lidIn = gfx.texture(b.lidIn, b.lidIn.width, b.lidIn.height);
        this.tex.drawer = gfx.texture(b.drawer, b.drawer.width, b.drawer.height);
        this.tex.stay = gfx.texture(b.stay, b.stay.width, b.stay.height);
        this.tex.paper = gfx.texture(paper, paper.width, paper.height);
        for (const k of ['lidOut', 'lidIn', 'drawer', 'stay']) {
            b[k].close();
            delete b[k];
        }
        this.tex.body = this.tex.base;
        this.tex.prev = null;
        if (this.tinted)
            this.tex.body = gfx.texture(this.tinted, this.tinted.width, this.tinted.height);
        for (const m of [...this.faces.shut, ...this.faces.open, this.shade, this.stayMesh])
            if (m)
                gfx.remove(m);
        const sh = this.rig.shut, op = this.rig.openFaces;
        // (the big face last: the edges lie beside it)
        this.faces.shut = [sh.front, sh.right, sh.out].map(f => gfx.add(this.faceMesh(f.uv, f.rig, L.lidOut)));
        this.faces.open = [op.top, op.right, op.in].map(f => gfx.add(this.faceMesh(f.uv, f.rig, L.lidIn)));
        this.board = this.rig.board.map(p => this.insideAt(p));
        this.rack = this.insideAt(RACK);
        this.shade = gfx.add(this.faceMesh(this.rig.trayShade.map(p => this.inLayer(L.body, p)), this.rig.trayShade.map(() => [0, 0, 0]), L.body, 1));
        // the stay: a strip of its texture between the pivot's end and the feet's
        const m = gridMesh(1, 6), Q = this.rig.stay.quad.map(p => this.inLayer(L.stay, p));
        for (let k = 0; k < m.n; k++) {
            const u = m.uv[k * 2], v = m.uv[k * 2 + 1];
            m.uv[k * 2] = lerp(lerp(Q[0][0], Q[1][0], u), lerp(Q[3][0], Q[2][0], u), v) / L.stay.wh[0];
            m.uv[k * 2 + 1] = lerp(lerp(Q[0][1], Q[1][1], u), lerp(Q[3][1], Q[2][1], u), v) / L.stay.wh[1];
        }
        this.stayMesh = gfx.add(m);
        for (const q of [this.sheet, this.easel, this.bodyQuad, this.drawerQuad])
            gfx.add(q);
    }
    rigAt(a, s, r, q) {
        const RIG = this.rig;
        const c = Math.cos(a * Math.PI / 180), n = Math.sin(a * Math.PI / 180), t = RIG.t, k = ease(clamp(a / RIG.open, 0, 1));
        let x = 0, y = 0;
        for (let e = 0; e < 2; e++) {
            const w = e ? s : 1 - s, hs = RIG.hS[e], ho = RIG.hO[e], A = RIG.A[e], B = RIG.B[e];
            x += w * (hs[0] + (ho[0] - hs[0]) * k + r * (c * A[0] + n * B[0]) + q * t * (c * B[0] - n * A[0]));
            y += w * (hs[1] + (ho[1] - hs[1]) * k + r * (c * A[1] + n * B[1]) + q * t * (c * B[1] - n * A[1]));
        }
        return [x, y];
    }
    // how far the drawer is out with the lid at a, along the box's depth (frame px; 0 as drawn open)
    travel(a) {
        const tv = this.rig.drawer.travel, i = clamp(a, 0, tv.length - 1), i0 = Math.floor(i);
        return lerp(tv[i0], tv[Math.min(tv.length - 1, i0 + 1)], i - i0);
    }
    // the stay's corners with the lid at a: its top rides the pivot on the lid's back, its feet the drawer
    stayCorners(a) {
        const S = this.rig.stay, Q = S.quad, du = this.rig.drawer.du, d = this.travel(a);
        const p = this.rigAt(a, S.pivot[0], S.pivot[1], 1), p0 = this.rigAt(this.rig.open, S.pivot[0], S.pivot[1], 1);
        return [[Q[0][0] + p[0] - p0[0], Q[0][1] + p[1] - p0[1]], [Q[1][0] + p[0] - p0[0], Q[1][1] + p[1] - p0[1]],
            [Q[2][0] + du[0] * d, Q[2][1] + du[1] * d], [Q[3][0] + du[0] * d, Q[3][1] + du[1] * d]];
    }
    inLayer(L, p) { return [p[0] - L.o[0], p[1] - L.o[1]]; }
    // (s, r) on the lid's inside for a point of the open drawing
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
    // a face as a mesh: its corners in its layer's texture (px) and on the rig (s, r, q), filled in between
    faceMesh(uvC, rigC, L, cols = 4) {
        const m = gridMesh(cols, cols);
        m.par = new Float32Array(m.n * 3);
        const bl = (C, u, v, i) => lerp(lerp(C[0][i], C[1][i], u), lerp(C[3][i], C[2][i], u), v);
        for (let k = 0; k < m.n; k++) {
            const u = m.uv[k * 2], v = m.uv[k * 2 + 1];
            for (let i = 0; i < 3; i++)
                m.par[k * 3 + i] = bl(rigC, u, v, i);
            m.uv[k * 2] = bl(uvC, u, v, 0) / L.wh[0];
            m.uv[k * 2 + 1] = bl(uvC, u, v, 1) / L.wh[1];
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
    // a layer's quad at its place in the frame, moved by (dx, dy) frame px
    placeLayer(m, F, L, dx = 0, dy = 0) {
        const x = F.ox + (L.o[0] + dx) * F.k, y = F.oy + (L.o[1] + dy) * F.k, w = L.wh[0] * F.k, h = L.wh[1] * F.k;
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
    // the shut box's place on the screen (the menu and a click go by it)
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
    // its lid swings on the hinge, a little past its rest when flung open (the stay catches it) and with a small bounce
    // when it drops shut; crack: a few degrees open (while it works on its own)
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
    // the sheet on the lid's board, standing on the rail over the type blocks: as tall as fits and as wide as the
    // picture's shape asks; the ones waiting their turn stand behind it, a little askew; inset takes the picture's margin
    // off ((s, r) corners)
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
        const cx = (s0 + s1) / 2 + (i ? side * 0.012 * i : 0), cy = rB * DEPTH + bh * 0.03 + h / 2 + i * 0.004;
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
        return this.onScreen(F, [p[0] + (Math.random() - 0.5) * 40, p[1] + (Math.random() - 0.5) * 18]);
    }
    crackPoint(F) { return this.onScreen(F, this.rigAt(0, 0.5, 1, 0.5)); }
    /** A type block in the lid's rack, on the screen, with the lid at ang; and the way out of the rack (unit). */
    rackPoint(F, ang) {
        const [s, r] = this.rack, at = this.onScreen(F, this.rigAt(ang, s, r, 0)), off = this.onScreen(F, this.rigAt(ang, s, r, -0.3));
        const dx = off[0] - at[0], dy = off[1] - at[1], d = Math.hypot(dx, dy) || 1;
        return { at, out: [dx / d, dy / d] };
    }
    keyPoint(F) { return this.onScreen(F, KEYHOLE); }
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
    }
    // the box: the drawer and the stay behind it all, its body, and the lid on its hinge (past upright it stands behind
    // the tray). While the lid is low over the tray the tray lies in its shade; the big face darkens as it turns from the
    // light (the outside towards the back, the inside down over the tray); on the inside the sheet she paints on
    draw(gfx, F, look) {
        const RIG = this.rig, T = this.tex, a = look.ang, alpha = look.alpha;
        const fade = this.fadeShare();
        const drawBack = (ang, al, glow) => {
            const d = this.travel(ang);
            if (d > RIG.drawer.travel[0] + 0.5) { // (home, all of it is inside the box)
                this.placeLayer(this.drawerQuad, F, RIG.layers.drawer, RIG.drawer.du[0] * d, RIG.drawer.du[1] * d);
                gfx.draw(gfx.p1, this.drawerQuad, T.drawer, al, glow ? GLOW : undefined);
            }
            const folded = sm(RIG.stay.fold[0], RIG.stay.fold[1], ang);
            if (folded > 0.01) {
                this.setPts(this.stayMesh, this.stayCorners(ang).map(p => this.onScreen(F, p)));
                gfx.draw(gfx.p1, this.stayMesh, T.stay, folded * al, glow ? GLOW : undefined);
            }
        };
        const drawBody = (al, glow) => {
            this.placeLayer(this.bodyQuad, F, RIG.layers.body);
            if (glow) {
                gfx.draw(gfx.p1, this.bodyQuad, T.body, al, GLOW);
                return;
            }
            if (fade < 1 && T.prev) {
                gfx.draw(gfx.p1, this.bodyQuad, T.prev, al);
                gfx.draw(gfx.p1, this.bodyQuad, T.body, fade * al);
            }
            else
                gfx.draw(gfx.p1, this.bodyQuad, T.body, al);
            const shade = 0.55 * (1 - sm(RIG.edgeOn * 0.5, RIG.open * 0.92, a));
            if (look.fadeOpen === undefined && shade > 0.01 && a > 0.3) {
                this.setPts(this.shade, RIG.trayShade.map(p => this.onScreen(F, p)));
                gfx.draw(gfx.p1, this.shade, T.body, shade * al, { tint: [0.1, 0.06, 0.03], mix: 1 });
            }
        };
        const drawLid = (ang, al, glow) => {
            const shut = ang < RIG.edgeOn, faces = shut ? this.faces.shut : this.faces.open, tx = shut ? T.lidOut : T.lidIn;
            const dim = shut ? 0.3 * ang / RIG.edgeOn : 0.3 * clamp((RIG.open - ang) / (RIG.open - RIG.edgeOn), 0, 1);
            faces.forEach((m, i) => {
                this.placeRig(m, ang, F);
                gfx.draw(gfx.p1, m, tx, al, glow ? GLOW : i === 2 && dim > 0.004 ? { tint: [0, 0, 0], mix: dim } : undefined);
            });
            if (!shut && !glow)
                this.drawSheets(F, ang, look, al);
        };
        const whole = (ang, al, glow) => {
            drawBack(ang, al, glow);
            if (ang > 90) {
                drawLid(ang, al, glow);
                drawBody(al, glow);
            }
            else {
                drawBody(al, glow);
                drawLid(ang, al, glow);
            }
        };
        if (look.glow > 0.01) {
            const off = [gfx.off[0], gfx.off[1]], r = 3;
            for (let i = 0; i < 8; i++) {
                const t = i * Math.PI / 4;
                gfx.off = [off[0] - Math.cos(t) * r, off[1] - Math.sin(t) * r];
                const g = 0.34 * look.glow * alpha;
                if (look.fadeOpen === undefined)
                    whole(a, g, true);
                else
                    drawBody(g, true);
            }
            gfx.off = off;
        }
        if (look.fadeOpen !== undefined) {
            // (still: the open state fades in over the shut one, no hinge)
            const o = look.fadeOpen;
            if (o > 0.004) {
                drawBack(RIG.open, o * alpha);
                drawLid(RIG.open, o * alpha);
            }
            drawBody(alpha);
            if (o < 0.996)
                drawLid(0, (1 - o) * alpha);
            return;
        }
        whole(a, alpha);
    }
    fadeIn = 1;
    /** The tinted body's share while it fades in over the old one. */
    fadeShare() { return this.fadeIn; }
    stepFade(dt) { this.fadeIn = Math.min(1, this.fadeIn + dt * 1.4); }
    get fading() { return this.fadeIn < 1; }
    // the paint in the pans takes the picture's colours, baked into a copy of the box's body that fades in over the old
    // one (at once when it comes back from the last visit)
    tint(cols, fade = true) {
        if (this.wet !== undefined) {
            this.wet = cols.map(q => q.slice());
            return;
        }
        this.bake(cols, fade, false);
    }
    /** The pans run dry (bare porcelain, a trace of paint left), or take their paint back. */
    dry(on) {
        if (on === (this.wet !== undefined))
            return;
        if (on) {
            this.wet = this.colours ? this.colours.map(q => q.slice()) : null;
            this.bake(Array.from({ length: 8 }, () => PORCELAIN), true, true);
            return;
        }
        const back = this.wet;
        this.wet = undefined;
        if (back)
            this.bake(back, true, false);
        else
            this.untint();
    }
    // the pans painted over: a picture's colours on the cakes' own light and shade, or flat (bare porcelain)
    bake(cols, fade, flat) {
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
                d[i + ch] = d[i + ch] * (1 - k) + (flat ? q[ch] : Math.min(255, q[ch] * l / lq)) * k;
        }
        x.putImageData(id, 0, 0);
        this.colours = flat ? null : cols.map(q => q.slice());
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
    // back to the pans as drawn, fading in
    untint() {
        this.colours = null;
        this.tinted = null;
        const gfx = this.gfx, T = this.tex;
        if (!gfx || !T.base)
            return;
        if (T.prev && T.prev !== T.base)
            gfx.free(T.prev);
        T.prev = T.body;
        T.body = T.base;
        this.fadeIn = 0;
    }
    /** The pans' colours to keep (the ones they had before they ran dry). */
    get palette() { return this.wet !== undefined ? this.wet : this.colours; }
    /** The shut box as one picture (the frame, texture px), for the still mode: the body, then the shut lid's faces. */
    shutPicture() {
        const body = this.tinted ?? this.bitmaps.body, out = this.bitmaps.lidOut;
        if (!body || !out)
            return null;
        const S = this.rig.size, L = this.rig.layers, c = document.createElement('canvas');
        c.width = S[0];
        c.height = S[1];
        const x = c.getContext('2d');
        if (!x)
            return null;
        x.drawImage(body, L.body.o[0], L.body.o[1]);
        const sh = this.rig.shut;
        for (const f of [sh.front, sh.right, sh.out]) {
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
        this.tex = { body: null, prev: null, base: null, lidOut: null, lidIn: null, drawer: null, stay: null, paper: null };
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
