import { R } from './tia.js';
import { clamp, lerp } from './state.js';
export const LINES = {
    menu: '画匣已经支好了。今天要给哪一段故事配画？',
    dragged: '唔……换个角落摆画架吗？这里光线确实更顺手一点。',
    away: '我先把画匣合上歇会儿，后台正在画的稿子不会停的，放心。',
    reading: '别催别催，我正顺着字里行间找适合落笔的位置呢……',
    found: '找到了，这几幕光影正好，画框已经给你嵌进楼层里啦。',
    queued: '前面还有正在调色的画布，这张草稿我先按顺序压在镇纸下面啦。',
    unqueued: '唔，这张先不画了吗？那我把空白画纸收回匣子里咯。',
    drawing: '外貌铜牌核对无误，画师底色铺好……凝！',
    columns: '左边留给第一位，右边留给第二位，分栏结界已经隔开了，绝不会把发色染串的。',
    done: '干透啦，快看看显影效果！要是觉得光影差一点，点右边的按钮我再给你重画一版。',
    reference: '等一下，画匣名册里还没有登记这位角色或衣服的标签呢，先去锚定页补上档案我才能下笔呀。',
    network: '呜，远方的魔力回路好像断开了，颜料送不过来……稍微检查一下接口密钥吧？',
};
// how long each stays up (ms), as the sample had them
const SHOW = {
    menu: 2600, dragged: 3400, away: 3400, reading: 3200, found: 3400, queued: 3400, unqueued: 3000,
    drawing: 2600, columns: 3600, done: 4200, reference: 5200, network: 5200,
};
const QUIET_MS = 3 * 60 * 1000;
export class Speech {
    m;
    el;
    box;
    said = new Map();
    on = false;
    w = 0;
    h = 0;
    x = -1;
    y = -1;
    tail = -1;
    token = 0;
    /** Her lines are on (使用偏好). */
    lines = true;
    constructor(m, layer) {
        this.m = m;
        this.box = document.createElement('div');
        this.box.className = 'pet-note-at';
        this.el = document.createElement('div');
        this.el.className = 'note';
        this.el.setAttribute('role', 'status');
        this.el.setAttribute('aria-live', 'polite');
        this.box.append(this.el);
        layer.append(this.box);
    }
    get showing() { return this.on; }
    /** Her line, unless lines are off or she said it in the last three minutes. */
    pick(line) {
        if (!this.lines)
            return '';
        const now = Date.now(), last = this.said.get(line);
        if (last !== undefined && now - last < QUIET_MS)
            return '';
        this.said.set(line, now);
        return LINES[line];
    }
    /** Says a line (quiet rule), with the plugin's own message under it when given; a message alone when the line is quiet. */
    say(line, fact = '', alone = !!fact) {
        const text = line ? this.pick(line) : '';
        if (!text && !(fact && alone))
            return;
        this.show(text, line ? SHOW[line] + (fact ? 1600 : 0) : 4200, fact);
    }
    // her words, and under them (when given) the plugin's own message, in its plain type
    show(text, ms, fact) {
        const st = this.m.st;
        if (st.away)
            return;
        this.el.replaceChildren();
        if (text)
            this.el.append(text);
        if (fact) {
            const small = document.createElement('small');
            small.textContent = fact;
            this.el.append(small);
        }
        this.el.classList.toggle('fact-only', !text);
        this.el.classList.add('on');
        this.on = true;
        this.m.noteOn = true;
        this.w = this.el.offsetWidth;
        this.h = this.el.offsetHeight;
        this.place(0);
        const token = ++this.token;
        this.m.later(ms / 1000, () => { if (token === this.token)
            this.hide(); });
    }
    hide() {
        this.token++;
        this.el.classList.remove('on');
        this.on = false;
        this.m.noteOn = false;
    }
    // the note rides above her hat, wherever she is carried; in the screen's side over the middle of what is out of the
    // edge; while she rests in the paintbox, over it
    place(dt) {
        if (!this.on)
            return;
        const m = this.m, st = m.st, W = m.view.w;
        let head = m.toScreen(...R.top);
        if (st.mode === 'side' && st.side) {
            const right = st.side.dir === 'R', top = m.toScreen(right ? 735 : 87, 300);
            head = [(head[0] + (right ? W : 0)) / 2, top[1]];
        }
        if (st.duck > 0.5)
            this.hide();
        const tx = clamp(head[0] - this.w * 0.8, 8, W - this.w - 8), ty = Math.max(8, head[1] - this.h - 14);
        const k = dt ? Math.min(1, dt * 12) : 1;
        this.x = this.x < 0 ? tx : lerp(this.x, tx, k);
        this.y = this.y < 0 ? ty : lerp(this.y, ty, k);
        this.box.style.transform = `translate(${Math.round(this.x)}px, ${Math.round(this.y)}px)`;
        const tail = Math.round(clamp(head[0] - this.x, 16, this.w - 16));
        if (tail !== this.tail) {
            this.tail = tail;
            this.el.style.setProperty('--tail', `${tail}px`);
        }
    }
    dispose() { this.box.remove(); }
}
