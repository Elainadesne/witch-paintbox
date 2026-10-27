// The GL side: two programs (a textured mesh with tint, and the easel's wash-and-bloom), meshes kept on the CPU so they
// can be built again after a lost context, and textures. Positions are page CSS px; u_off is the canvas's corner on
// the page, u_res its size, so only a small canvas around her is ever drawn.
const VS = `#version 300 es
in vec2 a_pos; in vec2 a_uv; uniform vec2 u_res; uniform vec2 u_off; out vec2 v_uv;
void main(){ v_uv=a_uv; vec2 c=(a_pos-u_off)/u_res*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); }`;
const FS = `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha; uniform vec3 u_tint; uniform float u_mix;
uniform float u_bias;
out vec4 o; void main(){ vec4 c=texture(u_tex,v_uv,u_bias); c.rgb=mix(c.rgb,u_tint*c.a,u_mix); o=c*u_alpha; }`;
// the picture on the easel: it blooms in like a wash (noise and distance from the middle), its edge a little darker
const FS_PAINT = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha; uniform float u_reveal; uniform float u_wash;
out vec4 o;
float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int k=0;k<5;k++){ s+=a*n(p); p*=2.07; a*=0.5; } return s; }
void main(){
  vec4 c=texture(u_tex,v_uv);
  float m=fbm(v_uv*vec2(5.0,4.0))*0.55+length((v_uv-0.5)*vec2(1.2,1.0))*0.9;
  float r=u_reveal*1.25;
  float vis=smoothstep(r,r-0.09,m);
  float edge=smoothstep(r-0.09,r-0.03,m)*vis;
  vec3 wash=mix(vec3(0.93,0.86,0.70),vec3(0.80,0.62,0.34),fbm(v_uv*3.0+u_wash*0.15));
  float wm=smoothstep(0.75,0.35,fbm(v_uv*vec2(3.0,2.4)+vec2(u_wash*0.08,0.0))+length(v_uv-0.5)*0.5)*clamp(u_wash,0.0,1.0)*0.55;
  vec3 col=mix(vec3(0.97,0.93,0.85),wash,wm);
  col=mix(col,c.rgb*(1.0-edge*0.35),vis);
  o=vec4(col,1.0)*u_alpha;
}`;
const UNIFORMS = ['u_res', 'u_off', 'u_tex', 'u_alpha', 'u_tint', 'u_mix', 'u_bias', 'u_reveal', 'u_wash'];
export function gridMesh(cols, rows) {
    const n = (cols + 1) * (rows + 1);
    const uv = new Float32Array(n * 2);
    for (let j = 0; j <= rows; j++)
        for (let i = 0; i <= cols; i++) {
            const k = j * (cols + 1) + i;
            uv[k * 2] = i / cols;
            uv[k * 2 + 1] = j / rows;
        }
    const idx = new Uint16Array(cols * rows * 6);
    let q = 0;
    for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
            const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
            idx.set([a, b, c, b, d, c], q);
            q += 6;
        }
    return { n, cols, rows, uv, rest: new Float32Array(n * 2), pos: new Float32Array(n * 2), idx, count: idx.length,
        vao: null, pb: null, ub: null, ib: null };
}
export class Gfx {
    gl;
    p1;
    p2;
    meshes = new Set();
    textures = new Set();
    /** The canvas's size and corner on the page (CSS px). */
    res = [1, 1];
    off = [0, 0];
    constructor(gl) {
        this.gl = gl;
        this.build();
    }
    /** Programs and every mesh's buffers, again (after a restored context). */
    build() {
        const gl = this.gl;
        this.p1 = this.program(FS);
        this.p2 = this.program(FS_PAINT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        for (const m of this.meshes)
            this.gpu(m);
    }
    program(fs) {
        const gl = this.gl;
        const p = gl.createProgram();
        for (const [type, source] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost())
                throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
            gl.attachShader(p, shader);
            gl.deleteShader(shader);
        }
        gl.bindAttribLocation(p, 0, 'a_pos');
        gl.bindAttribLocation(p, 1, 'a_uv');
        gl.linkProgram(p);
        const u = {};
        for (const name of UNIFORMS)
            u[name] = gl.getUniformLocation(p, name);
        return { p, u };
    }
    /** Registers a CPU mesh and gives it buffers. */
    add(m) {
        if (this.meshes.has(m))
            return m;
        this.meshes.add(m);
        this.gpu(m);
        return m;
    }
    remove(m) {
        if (!this.meshes.delete(m))
            return;
        const gl = this.gl;
        if (!gl.isContextLost()) {
            gl.deleteVertexArray(m.vao);
            for (const b of [m.pb, m.ub, m.ib])
                if (b)
                    gl.deleteBuffer(b);
        }
        m.vao = m.pb = m.ub = m.ib = null;
    }
    gpu(m) {
        const gl = this.gl;
        m.vao = gl.createVertexArray();
        gl.bindVertexArray(m.vao);
        if (m.over) {
            m.pb = null;
            gl.bindBuffer(gl.ARRAY_BUFFER, m.over.pb);
        }
        else {
            m.pb = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, m.pb);
            gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.DYNAMIC_DRAW);
        }
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        m.ub = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, m.ub);
        gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        m.ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
    }
    upload(m) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, m.pb);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.pos);
    }
    uploadUV(m) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, m.ub);
        gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
    }
    draw(pr, m, t, alpha, extra) {
        const gl = this.gl;
        gl.useProgram(pr.p);
        gl.uniform2f(pr.u.u_res, this.res[0], this.res[1]);
        gl.uniform2f(pr.u.u_off, this.off[0], this.off[1]);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.t);
        gl.uniform1i(pr.u.u_tex, 0);
        gl.uniform1f(pr.u.u_alpha, alpha);
        if (pr.u.u_tint) {
            const tint = extra?.tint ?? [0, 0, 0];
            gl.uniform3f(pr.u.u_tint, tint[0], tint[1], tint[2]);
            gl.uniform1f(pr.u.u_mix, extra?.mix ?? 0);
            gl.uniform1f(pr.u.u_bias, extra?.bias ?? 0);
        }
        if (pr.u.u_reveal) {
            gl.uniform1f(pr.u.u_reveal, extra?.reveal ?? 0);
            gl.uniform1f(pr.u.u_wash, extra?.wash ?? 0);
        }
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    }
    /** A texture from a decoded picture. Bitmaps come premultiplied already; canvases are premultiplied on upload. */
    texture(source, w, h, into) {
        const gl = this.gl;
        const tex = into ?? { t: null, w, h };
        if (tex.t)
            gl.deleteTexture(tex.t);
        tex.t = gl.createTexture();
        tex.w = w;
        tex.h = h;
        gl.bindTexture(gl.TEXTURE_2D, tex.t);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.textures.add(tex);
        return tex;
    }
    free(tex) {
        if (!tex)
            return;
        if (tex.t)
            this.gl.deleteTexture(tex.t);
        tex.t = null;
        this.textures.delete(tex);
    }
    /** After a lost context every GL name is dead: forget them (the owners upload again). */
    forget() {
        for (const tex of this.textures)
            tex.t = null;
        this.textures.clear();
        for (const m of this.meshes) {
            m.vao = m.pb = m.ub = m.ib = null;
        }
    }
    dispose() {
        const gl = this.gl;
        if (!gl.isContextLost()) {
            for (const tex of this.textures)
                if (tex.t)
                    gl.deleteTexture(tex.t);
            for (const m of this.meshes) {
                gl.deleteVertexArray(m.vao);
                for (const b of [m.pb, m.ub, m.ib])
                    if (b)
                        gl.deleteBuffer(b);
            }
            gl.deleteProgram(this.p1.p);
            gl.deleteProgram(this.p2.p);
        }
        this.forget();
        this.meshes.clear();
    }
}
// a soft round shadow, for the floor (stretched flat when drawn); near black, so it darkens even a dark page
export function shadowCanvas() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [k, a] of [[0, 1], [0.3, 0.72], [0.55, 0.36], [0.8, 0.1], [1, 0]])
        g.addColorStop(k, `rgba(12,8,4,${a})`);
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    return c;
}
// the paper the pictures come on: warm white, a faint grain, its edge a shade darker
export function paperCanvas() {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#f6efe0';
    x.fillRect(0, 0, 96, 128);
    const id = x.getImageData(0, 0, 96, 128), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
        const g = (Math.random() - 0.5) * 7;
        d[i] += g;
        d[i + 1] += g;
        d[i + 2] += g * 0.8;
    }
    x.putImageData(id, 0, 0);
    x.strokeStyle = 'rgba(150,118,78,.32)';
    x.lineWidth = 2;
    x.strokeRect(1, 1, 94, 126);
    return c;
}
/** A picture file of the pet's own, decoded. Premultiplied for textures; 'none' keeps exact values for maps read on the CPU. */
export async function loadBitmap(url, signal, exact = false) {
    const response = await fetch(url, { signal });
    if (!response.ok)
        throw new Error(`${response.status} ${url}`);
    const blob = await response.blob();
    return createImageBitmap(blob, exact ? { premultiplyAlpha: 'none', colorSpaceConversion: 'none' } : { premultiplyAlpha: 'premultiply' });
}
/** A bitmap's pixels on the CPU. */
export function pixels(source, w, h, sw = w, sh = h) {
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(source, 0, 0, w, h, 0, 0, sw, sh);
    return x.getImageData(0, 0, sw, sh).data;
}
