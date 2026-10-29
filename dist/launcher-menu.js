import { ChatProcessor } from './chat-processor.js';
import { bindIllustrationPicker } from './illustration-picker.js';
import { emitPetEvent } from './pet-events.js';
// 画匣里的三样东西，手绘棕墨线加一点水彩：画笔（AI生图）、插图卡（指定插图）、调色刀（设置）
const icons = {
    brush: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <path class="wash" d="M6 33c3-4 7-6 10-5s1 6-4 7-8 0-6-2z"/>
    <path class="ink" d="M24.5 15.5 33 4.6c1-1.3 2.9.3 1.8 1.6l-9 10.3"/>
    <path class="metal" d="m22.2 14.1 4.5 3.9-2.3 2.6-4.5-3.9z"/>
    <path class="tip" d="M19.9 16.7 24.4 20.6c-1.9 3.6-4.4 7.4-9.1 9.6-2.5 1.2-6.4 1.9-8.6 1.2 2.4-1.3 3.6-3.8 4.3-6.2 1.3-4.6 4.3-7.4 8.9-8.5z"/>
    <path class="line" d="M14.3 27.1c1.6-.5 3.3-1.6 4.6-3.2"/>
  </svg>`,
    card: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <path class="paper" d="M8.3 9.6 29.4 6.2c.9-.1 1.7.5 1.8 1.3l3.1 22.6c.1.9-.5 1.7-1.4 1.8L11.8 35c-.9.1-1.7-.5-1.8-1.3L7 11.4c-.1-.9.5-1.7 1.3-1.8z"/>
    <path class="wash" d="M11.2 15.6 29 12.7l1.6 11.9-17.7 2.7z"/>
    <path class="hill" d="m12.6 26.8 5.6-6.2 4.2 3.8 2.6-2.5 5.4 2.8.3 1.6z"/>
    <circle class="sun" cx="25.3" cy="16.6" r="1.9"/>
    <path class="pin" d="M18.6 4.7c1.4-.6 3 .2 3.4 1.6.2.9-.1 1.8-.8 2.3l-2.5-.2c-.9-.9-1-2.7-.1-3.7z"/>
  </svg>`,
    knife: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <path class="wash" d="M21 10c5-3 12-2 13 3s-4 8-9 7-8-7-4-10z"/>
    <path class="blade" d="M32.6 6.2c1.1-.7 2.3.4 1.7 1.5L23.2 22.4l-3.5-2.9z"/>
    <path class="neck" d="m19.7 19.5 3.5 2.9-2.8 1.9c-.8.5-1.8.4-2.4-.3s-.5-1.7.1-2.4z"/>
    <path class="handle" d="M17.9 23.3c.8.8 1.9.9 2.6.3L11.6 33.5c-1.1 1.3-3 1.4-4.2.3-1.1-1.1-1-3 .3-4.1z"/>
    <path class="line" d="M28.4 10.7 24 16.3"/>
  </svg>`,
};
function item(action, title, label, hint, icon, paint) {
    return `<button type="button" ${action} ${title ? `title="${title}"` : ''} style="--paint:${paint}">
    <span class="menu-object">${icon}</span><span class="menu-label"><strong>${label}</strong><small>${hint}</small></span></button>`;
}
export function bindLauncherMenu(launcher, root, signal, configure, options = {}) {
    const menu = document.createElement('div');
    menu.id = 'witch-launcher-menu';
    menu.className = 'launcher-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', '魔女画匣快捷菜单');
    menu.innerHTML = `<i class="menu-tail" aria-hidden="true"></i>
    <p class="menu-eyebrow" aria-hidden="true">从画匣里取出……</p>
    ${item('data-process', '让预设 AI 为最新回复插入配图标记', 'AI生图', '为最新回复挑画面', icons.brush, '#E6872A')}
    ${item('data-select', '', '指定插图', '自己圈出要画的段落', icons.card, '#C8A04C')}
    ${item('data-configure', '', '设置', '接口、锚定与偏好', icons.knife, '#8C6649')}
    <p role="status"></p><button type="button" data-cancel hidden>取消处理</button>`;
    root.append(menu);
    launcher.setAttribute('aria-controls', menu.id);
    const processButton = menu.querySelector('[data-process]');
    const selectButton = menu.querySelector('[data-select]');
    const cancelButton = menu.querySelector('[data-cancel]');
    const tail = menu.querySelector('.menu-tail');
    const status = menu.querySelector('p[role="status"]');
    const processor = new ChatProcessor((message, busy, error, cancellable = true) => {
        status.textContent = message;
        status.classList.toggle('is-error', !!error);
        menu.classList.toggle('is-busy', busy);
        processButton.disabled = busy;
        selectButton.disabled = busy;
        cancelButton.hidden = !busy;
        cancelButton.disabled = !cancellable;
        launcher.classList.toggle('processing', busy);
        picker.report(message, busy, !!error, cancellable);
        if (!menu.hidden)
            place();
    });
    const picker = bindIllustrationPicker(root, signal, processor);
    // 贴着画匣弹出：优先放在画匣远离缇娅的一侧；放不下就放到画匣上方或下方；都不行再退回整体旁边。
    function place() {
        const box = options.box?.() ?? launcher.getBoundingClientRect();
        const whole = options.anchor?.() ?? box;
        const vw = window.innerWidth, vh = window.innerHeight, gap = 14, edge = 8;
        const w = menu.offsetWidth, h = menu.offsetHeight;
        const tiaOnLeft = whole.left < box.left - 4;
        const tiaOnRight = whole.right > box.right + 4;
        const fitsRight = box.right + gap + w <= vw - edge;
        const fitsLeft = box.left - gap - w >= edge;
        let side;
        if (tiaOnLeft && fitsRight)
            side = 'right';
        else if (tiaOnRight && fitsLeft)
            side = 'left';
        else if (fitsRight && !tiaOnRight)
            side = 'right';
        else if (fitsLeft && !tiaOnLeft)
            side = 'left';
        else if (box.top - gap - h >= edge)
            side = 'top';
        else if (box.bottom + gap + h <= vh - edge)
            side = 'bottom';
        else
            side = fitsRight ? 'right' : 'left';
        let left, top;
        if (side === 'right' || side === 'left') {
            left = side === 'right' ? box.right + gap : box.left - gap - w;
            top = box.top + box.height * 0.42 - h / 2;
        }
        else {
            left = box.left + box.width / 2 - w / 2;
            top = side === 'top' ? box.top - gap - h : box.bottom + gap;
        }
        left = Math.max(edge, Math.min(left, vw - w - edge));
        top = Math.max(edge, Math.min(top, vh - h - edge));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.dataset.side = side;
        // 小尾巴指向画匣中部（盖子开口处），并作为弹出晕开的起点
        const tx = Math.max(18, Math.min(box.left + box.width / 2 - left, w - 18));
        const ty = Math.max(18, Math.min(box.top + box.height * 0.42 - top, h - 18));
        if (side === 'right' || side === 'left') {
            tail.style.left = '';
            tail.style.top = `${ty}px`;
        }
        else {
            tail.style.top = '';
            tail.style.left = `${tx}px`;
        }
        menu.style.setProperty('--from-x', `${side === 'right' ? 0 : side === 'left' ? w : tx}px`);
        menu.style.setProperty('--from-y', `${side === 'top' ? h : side === 'bottom' ? 0 : ty}px`);
    }
    function close() {
        const wasOpen = !menu.hidden;
        menu.hidden = true;
        menu.classList.remove('is-opening');
        launcher.setAttribute('aria-expanded', 'false');
        if (wasOpen)
            emitPetEvent({ type: 'ui', action: 'menu-close' });
    }
    function open() {
        if (launcher.hidden)
            return;
        const opening = menu.hidden;
        menu.hidden = false;
        launcher.setAttribute('aria-expanded', 'true');
        place();
        if (opening) {
            menu.classList.remove('is-opening');
            void menu.offsetWidth;
            menu.classList.add('is-opening');
            window.setTimeout(() => menu.classList.remove('is-opening'), 420);
        }
        menu.querySelector('button:not(:disabled):not([hidden])')?.focus({ preventScroll: true });
        if (opening)
            emitPetEvent({ type: 'ui', action: 'menu-open' });
    }
    processButton.addEventListener('click', () => { void processor.process(); }, { signal });
    selectButton.addEventListener('click', () => { close(); picker.open(launcher); }, { signal });
    cancelButton.addEventListener('click', () => processor.cancel(), { signal });
    const configureButton = menu.querySelector('[data-configure]');
    configureButton.addEventListener('click', () => { const from = configureButton.getBoundingClientRect(); close(); configure(from); }, { signal });
    document.addEventListener('pointerdown', event => {
        if (!event.composedPath().includes(menu) && !event.composedPath().includes(launcher))
            close();
    }, { signal });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) {
            event.preventDefault();
            event.stopPropagation();
            close();
            launcher.focus();
        }
    }, { signal });
    window.addEventListener('resize', () => { if (!menu.hidden)
        place(); }, { signal });
    signal.addEventListener('abort', () => { processor.cancel(); menu.remove(); }, { once: true });
    return { open, close, toggle: () => menu.hidden ? open() : close() };
}
