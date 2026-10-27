// Her rig: one NAI picture of her, cut to her outline, bent by soft fields on a single mesh (head, hat and its tip, hair,
// arms, skirt); the loose parts (ahoge, braids, cup, and in the side her forearms) hang on layers of their own over what
// NAI painted in behind them; the face patches (cut to FACE) give her expressions.
import { gridMesh } from './gl.js';
import { clamp, lerp, sm } from './state.js';
export const TW = 912, TH = 1296; // her texture
// points in texture px (read off the master)
export const R = {
    neck: [456, 560], hat: [468, 320], tipPivot: [690, 238], top: [520, 84], waist: [456, 742], feet: [458, 1232],
    shL: [332, 650], hL: [262, 862], shR: [584, 650], hR: [652, 864], lap: [360, 850],
};
/** The rect the face patches are cut to (texture px). */
export const FACE = { x: 352, y: 440, w: 212, h: 128 };
// the brim's front edge, left to right (texture px): above it is hat
const BRIM = [[85, 290], [100, 305], [150, 392], [200, 452], [250, 466], [272, 435], [297, 400], [330, 331], [351, 314],
    [376, 304], [405, 298], [430, 302], [447, 323], [463, 348], [484, 368], [513, 411], [547, 439], [591, 467], [624, 489],
    [663, 500], [702, 511], [741, 517], [780, 517], [813, 506], [841, 489], [863, 467]];
const brimY = (x) => {
    if (x <= BRIM[0][0])
        return BRIM[0][1];
    for (let i = 1; i < BRIM.length; i++)
        if (x <= BRIM[i][0]) {
            const [x0, y0] = BRIM[i - 1], [x1, y1] = BRIM[i];
            return lerp(y0, y1, (x - x0) / (x1 - x0));
        }
    return BRIM[BRIM.length - 1][1];
};
function capsule(p, a, b, r, f) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby), 0, 1);
    const dx = p[0] - (a[0] + abx * t), dy = p[1] - (a[1] + aby * t);
    return { w: 1 - sm(r, r + f, Math.hypot(dx, dy)), t };
}
const FIELDS = ['head', 'hat', 'tip', 'hairL', 'hairR', 'armL', 'armR', 'skirt', 'chest'];
// how much each field moves a point of her, by where it rests
function weights(x, y) {
    const p = [x, y];
    const hat = sm(-3, 9, brimY(x) - y) * (1 - sm(528, 548, y));
    const al = capsule(p, R.shL, R.hL, 46, 10), ar = capsule(p, R.shR, R.hR, 46, 10);
    const below = sm(548, 700, y);
    return {
        head: 1 - sm(544, 580, y), hat, tip: hat * sm(676, 700, x) * (1 - sm(392, 404, y)),
        armL: al.w * sm(0, 0.9, al.t), armR: ar.w * sm(0, 0.9, ar.t),
        hairL: below * (1 - sm(292, 322, x)) * (1 - al.w), hairR: below * sm(590, 620, x) * (1 - ar.w),
        skirt: Math.pow(sm(760, 1090, y), 1.5) * sm(226, 252, x) * (1 - sm(664, 690, x)) * (1 - sm(1098, 1128, y)),
        chest: sm(742, 590, y),
    };
}
// in the screen's side she is all of herself turned a quarter round, head first out of the edge, the way she would
// come up over the bottom one: the edge crosses her at row SIDE.edge when she is out (her forearms on it, a layer of
// GPT's; the edge goes through her fingertips, so they bend over it out of sight), at SIDE.hide when she has ducked
// in to her hat, at SIDE.gone when she is out of sight
export const SIDE = { edge: 628, hide: 292, gone: 40 };
// the loose parts, each on a layer of its own (cut from the master, with what was behind it painted in on the base):
// where it sits in the texture (x, y, w, h), the point it hangs from and its far end, its spring, how much of the
// swing its root takes (1: it swings stiff), and which of her fields it rides along with
const PARTS = {
    braidL: { r: [340, 541, 56, 200], root: [360, 556], end: [366, 736], s: 'bL', stiff: 0, ride: ['head', 'chest'], grid: [3, 12] },
    braidR: { r: [518, 541, 62, 191], root: [548, 556], end: [556, 726], s: 'bR', stiff: 0, ride: ['head', 'chest'], grid: [3, 12] },
    cup: { r: [332, 722, 94, 151], root: [405, 744], end: [372, 866], s: 'cup', stiff: 1, ride: ['chest'], grid: [4, 6] },
    ahoge: { r: [272, 219, 91, 92], root: [356, 304], end: [292, 236], s: 'ah', stiff: 0.25, ride: ['head', 'chest'], grid: [6, 6] },
    // (in the side only: her forearms on the edge; they hold still)
    arms: { r: [207, 538, 506, 99], root: [456, 560], end: [456, 628], s: 'still', stiff: 1, ride: ['chest'], grid: [6, 2] },
};
export const TIA_FILES = {
    base: 'tia_base.webp', blink: 'tia_face_blink.webp', focus: 'tia_face_focus.webp', happy: 'tia_face_happy.webp',
    dismay: 'tia_face_dismay.webp', talk: 'tia_face_talk.webp', braidL: 'tia_braidL.webp', braidR: 'tia_braidR.webp',
    cup: 'tia_cup.webp', ahoge: 'tia_ahoge.webp', arms: 'tia_arms.webp',
};
/** Coarse shapes over her opaque pixels (texture px: x, y, w, h), for the hit parts; fine pointers go by the alpha. */
export const HIT_SHAPES = [
    [140, 88, 517, 104], [100, 192, 620, 96], [105, 288, 619, 96], [159, 384, 674, 96], [262, 480, 544, 96], [200, 576, 514, 96],
    [131, 672, 653, 96], [112, 768, 703, 96], [126, 864, 663, 96], [220, 960, 474, 96], [261, 1056, 392, 96], [389, 1152, 136, 88],
];
export class Rig {
    body = gridMesh(56, 80);
    face;
    parts;
    W = {};
    hitMap = null;
    constructor() {
        const body = this.body;
        for (const f of FIELDS)
            this.W[f] = new Float32Array(body.n);
        for (let k = 0; k < body.n; k++) {
            const x = body.uv[k * 2] * TW, y = body.uv[k * 2 + 1] * TH;
            body.rest[k * 2] = x;
            body.rest[k * 2 + 1] = y;
            const w = weights(x, y);
            for (const f of FIELDS)
                this.W[f][k] = w[f];
        }
        this.face = faceMesh(body);
        const parts = {};
        for (const [name, def] of Object.entries(PARTS)) {
            const m = gridMesh(...def.grid);
            const part = { ...def, mesh: m, own: new Float32Array(m.n), w: {} };
            for (const f of def.ride)
                part.w[f] = new Float32Array(m.n);
            for (let k = 0; k < m.n; k++) {
                const x = def.r[0] + m.uv[k * 2] * def.r[2], y = def.r[1] + m.uv[k * 2 + 1] * def.r[3];
                m.rest[k * 2] = x;
                m.rest[k * 2 + 1] = y;
                part.own[k] = def.stiff + (1 - def.stiff) * sm(0, 1, capsule([x, y], def.root, def.end, 0, 1).t);
                const w = weights(x, y);
                for (const f of def.ride)
                    part.w[f][k] = w[f];
            }
            parts[name] = part;
        }
        this.parts = parts;
    }
    meshes() { return [this.body, this.face, ...Object.values(this.parts).map(p => p.mesh)]; }
    // the alpha, for hit tests (quarter size)
    buildHit(alpha, w, h) {
        const a = new Uint8Array(w * h);
        for (let i = 0; i < a.length; i++)
            a[i] = alpha[i * 4 + 3];
        this.hitMap = { w, h, a };
    }
    /** Is a point of her texture opaque? */
    opaque(x, y) {
        const map = this.hitMap;
        if (!map)
            return false;
        const i = Math.floor(x / 4), j = Math.floor(y / 4);
        if (i < 0 || j < 0 || i >= map.w || j >= map.h)
            return false;
        return map.a[j * map.w + i] > 90;
    }
    /** The mesh for the current pose: local parts first, then the head, the breath, then the whole figure. */
    pose(st, S, s) {
        const W = this.W, body = this.body;
        const br = (Math.sin(st.t * (Math.PI * 2 / 3.8)) + 1) * 0.5;
        const rot = (p, c, a) => { const sn = Math.sin(a), co = Math.cos(a), x = p[0] - c[0], y = p[1] - c[1]; p[0] = c[0] + x * co - y * sn; p[1] = c[1] + x * sn + y * co; };
        const p = [0, 0];
        const cR = Math.cos(st.rot), sR = Math.sin(st.rot), sx = (2 - st.sq) ** 0.5;
        const place = (m, k) => {
            const lx = (p[0] - st.piv[0]) * s * sx, ly = (p[1] - st.piv[1]) * s * st.sq;
            m.pos[k * 2] = st.P[0] + lx * cR - ly * sR;
            m.pos[k * 2 + 1] = st.P[1] + lx * sR + ly * cR;
        };
        for (let k = 0; k < body.n; k++) {
            p[0] = body.rest[k * 2];
            p[1] = body.rest[k * 2 + 1];
            let w;
            if ((w = W.tip[k]))
                rot(p, R.tipPivot, S.tip.x * w);
            if ((w = W.hat[k]))
                rot(p, R.hat, S.hat.x * w);
            if ((w = W.hairL[k]))
                p[0] += S.hairL.x * w * clamp((p[1] - 560) / 360, 0, 1.4);
            if ((w = W.hairR[k]))
                p[0] += S.hairR.x * w * clamp((p[1] - 560) / 360, 0, 1.4);
            if ((w = W.armL[k]))
                rot(p, R.shL, S.armL.x * w);
            if ((w = W.armR[k]))
                rot(p, R.shR, S.armR.x * w);
            if ((w = W.skirt[k]))
                p[0] += S.skirt.x * w;
            if ((w = W.head[k])) {
                rot(p, R.neck, S.head.x * w);
                p[1] += S.hx.x * w * 0.6;
            }
            p[1] -= 2.6 * br * W.chest[k];
            place(body, k);
        }
        // the loose parts: their own swing about where they hang, then the head and the breath they ride along with
        for (const P of Object.values(this.parts)) {
            const m = P.mesh, a = S[P.s].x, wh = P.w.head, wc = P.w.chest;
            for (let k = 0; k < m.n; k++) {
                p[0] = m.rest[k * 2];
                p[1] = m.rest[k * 2 + 1];
                rot(p, P.root, a * P.own[k]);
                if (wh && wh[k]) {
                    rot(p, R.neck, S.head.x * wh[k]);
                    p[1] += S.hx.x * wh[k] * 0.6;
                }
                if (wc)
                    p[1] -= 2.6 * br * wc[k];
                place(m, k);
            }
        }
    }
    /** Her screen bounds for the current pose. */
    bounds(side) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const take = (m) => {
            const pos = m.pos;
            for (let i = 0; i < pos.length; i += 2) {
                const x = pos[i], y = pos[i + 1];
                if (x < x0)
                    x0 = x;
                if (x > x1)
                    x1 = x;
                if (y < y0)
                    y0 = y;
                if (y > y1)
                    y1 = y;
            }
        };
        take(this.body);
        if (side)
            take(this.parts.arms.mesh);
        return { x0, y0, x1, y1 };
    }
    /**
     * Her and the loose parts over her, in the side her forearms on the edge too; the cup throws its shadow on her skirt:
     * down and right of it as the painting's light falls (so it turns with her), and only on her (the shadow pass keeps
     * to what is drawn already). `glow` draws a warm rim around her first (keyboard focus).
     */
    draw(gfx, T, st, s, alpha, glow) {
        const side = st.mode === 'side';
        const body = this.body, e = st.expr;
        gfx.upload(body);
        if (glow > 0.01) {
            const off = [gfx.off[0], gfx.off[1]], r = 3;
            for (let i = 0; i < 8; i++) {
                const a = i * Math.PI / 4;
                gfx.off = [off[0] - Math.cos(a) * r, off[1] - Math.sin(a) * r];
                gfx.draw(gfx.p1, body, T.base, 0.34 * glow * alpha, { tint: [0.96, 0.8, 0.46], mix: 1 });
            }
            gfx.off = off;
        }
        gfx.draw(gfx.p1, body, T.base, alpha);
        for (const k of ['focus', 'happy', 'dismay', 'talk'])
            if (e[k] > 0.01)
                gfx.draw(gfx.p1, this.face, T[k], e[k] * alpha);
        if (e.blink > 0.01 && e.happy < 0.5)
            gfx.draw(gfx.p1, this.face, T.blink, e.blink * alpha);
        const gl = gfx.gl;
        for (const k of side ? ['braidL', 'braidR', 'cup', 'ahoge', 'arms'] : ['braidL', 'braidR', 'cup', 'ahoge']) {
            const m = this.parts[k].mesh;
            if (k === 'cup') {
                const ox = 6 * s, oy = 13 * s, c = Math.cos(st.rot), n = Math.sin(st.rot);
                const dx = ox * c - oy * n, dy = ox * n + oy * c;
                for (let i = 0; i < m.n; i++) {
                    m.pos[i * 2] += dx;
                    m.pos[i * 2 + 1] += dy;
                }
                gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gfx.upload(m);
                gfx.draw(gfx.p1, m, T.cup, 0.55 * alpha, { tint: [0.2, 0.12, 0.06], mix: 1, bias: 1.2 });
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                for (let i = 0; i < m.n; i++) {
                    m.pos[i * 2] -= dx;
                    m.pos[i * 2 + 1] -= dy;
                }
            }
            gfx.upload(m);
            gfx.draw(gfx.p1, m, T[k], alpha);
        }
    }
}
// the face patches drawn over the part of her body mesh that covers FACE: uv = (rest - FACE.xy) / FACE.wh, clamped to
// the patch's transparent margin
function faceMesh(body) {
    const uv = new Float32Array(body.n * 2);
    for (let k = 0; k < body.n; k++) {
        uv[k * 2] = (body.rest[k * 2] - FACE.x) / FACE.w;
        uv[k * 2 + 1] = (body.rest[k * 2 + 1] - FACE.y) / FACE.h;
    }
    const cols = body.cols, cw = TW / cols, rh = TH / body.rows;
    const i0 = Math.max(0, Math.floor(FACE.x / cw)), i1 = Math.min(cols, Math.ceil((FACE.x + FACE.w) / cw));
    const j0 = Math.max(0, Math.floor(FACE.y / rh)), j1 = Math.min(body.rows, Math.ceil((FACE.y + FACE.h) / rh));
    const idx = new Uint16Array((i1 - i0) * (j1 - j0) * 6);
    let q = 0;
    for (let j = j0; j < j1; j++)
        for (let i = i0; i < i1; i++) {
            const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
            idx.set([a, b, c, b, d, c], q);
            q += 6;
        }
    return { n: body.n, cols: body.cols, rows: body.rows, uv, rest: body.rest, pos: body.pos, idx, count: idx.length, over: body,
        vao: null, pb: null, ub: null, ib: null };
}
