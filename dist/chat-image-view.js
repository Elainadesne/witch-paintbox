/** Match the surrounding page color while keeping the generation button's text white. */
function pageButtonColor(element) {
    const layers = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const color = getComputedStyle(parent).backgroundColor;
        if (!/^rgba?\(/.test(color))
            continue;
        const values = color.match(/[\d.]+/g)?.map(Number);
        if (!values || values.length < 3)
            continue;
        const alpha = values[3] ?? 1;
        if (alpha <= 0)
            continue;
        layers.push([values[0], values[1], values[2], alpha]);
        if (alpha >= 1)
            break;
    }
    let background = [40, 40, 48];
    for (const [r, g, b, alpha] of layers.reverse()) {
        background = [r, g, b].map((value, index) => value * alpha + background[index] * (1 - alpha));
    }
    const luminance = (rgb) => rgb.map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    let button = background.map(value => Math.min(255, value + 18));
    while (1.05 / (luminance(button) + .05) < 4.5)
        button = button.map(value => value * .9);
    return `rgb(${button.map(Math.round).join(', ')})`;
}
export function createChatImageView(summary, signal) {
    const slot = document.createElement('span');
    slot.className = 'witch-paintbox-image';
    slot.contentEditable = 'false';
    const root = slot.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
    :host { --button-surface: #45434e; --frame-inset: 8px; --image-width: 383px; --image-ratio: .6842; display: block; width: max-content; min-width: min(100%, calc(var(--image-width) + var(--frame-inset) + var(--frame-inset) + 2px)); max-width: 100%; margin: .8em auto; color: #3c3931; font: inherit; text-indent: 0; text-align: left; }
    *, *::before, *::after { box-sizing: border-box; }
    /* Weather's metal rails and the attribute card's bevelled corner fittings. */
    figure { position: relative; margin: 0; padding: var(--frame-inset); border: 1px solid #80683f; border-radius: 3px; background: linear-gradient(135deg, #e0c58e 0, #9c7843 24%, #ead5a1 52%, #a1814a 78%, #d2b779) border-box; box-shadow: 0 3px 10px #623d1a24, inset 0 1px 0 #fff3cf, inset 0 -1px 0 #5d472b88; }
    figure::before { content: ''; position: absolute; inset: 3px; border: 1px solid #bba06d; border-radius: 1px; background: #fdfaf2; box-shadow: inset 0 0 0 1px #fffcf0, 0 0 0 1px #71572e33; pointer-events: none; }
    .scene, .footer { position: relative; min-width: 0; }
    .frame-corner { position: absolute; z-index: 1; width: 24px; height: 24px; color: #8b6834; pointer-events: none; filter: drop-shadow(.5px .8px .3px #50391d55); }
    .frame-corner:nth-of-type(1) { top: 1px; left: 1px; }
    .frame-corner:nth-of-type(2) { top: 1px; right: 1px; transform: scaleX(-1); }
    .frame-corner:nth-of-type(3) { bottom: 1px; left: 1px; transform: scaleY(-1); }
    .frame-corner:nth-of-type(4) { bottom: 1px; right: 1px; transform: scale(-1); }
    .scene > summary { position: relative; display: grid; gap: 2px; padding: 5px 96px; text-align: center; list-style: none; cursor: pointer; overflow-wrap: anywhere; }
    .scene > summary::-webkit-details-marker { display: none; }
    .scene > summary::after { content: '⌄'; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); color: #8b6834; }
    .scene[open] > summary::after { content: '⌃'; }
    .scene-body { display: grid; gap: 8px; padding-top: 8px; min-width: 0; }
    .label { font-size: 10px; letter-spacing: .2em; opacity: .6; }
    .title { color: inherit; font: inherit; font-size: .95em; font-weight: 650; line-height: 1.65; text-wrap: balance; }
    .regenerate { position: absolute; right: 24px; top: 50%; transform: translateY(-50%); width: 66px; min-height: 36px; padding: 6px 2px; border: 1px solid #ffffff38; border-radius: 3px; background: var(--button-surface); color: #fff; font-size: 12px; line-height: 1.4; white-space: nowrap; }
    .regenerate:hover:not(:disabled) { filter: brightness(1.1); }
    button, a { font: inherit; -webkit-tap-highlight-color: transparent; }
    button { cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .generate { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; min-width: 0; contain: inline-size; min-height: 44px; padding: 10px 16px; border: 1px solid #ffffff38; border-radius: 3px; background: var(--button-surface); color: #fff; font-size: .85em; font-weight: 650; letter-spacing: .04em; }
    .generate:not(:disabled):hover { filter: brightness(1.1); }
    .generate:disabled { opacity: 1; color: #fff; }
    .generate .ornament { font-size: 15px; opacity: .7; }
    .canvas { display: grid; place-items: center; justify-self: center; width: var(--image-width); max-width: 100%; min-width: 0; aspect-ratio: var(--image-ratio); overflow: hidden; background: #ece5d5; border-radius: 2px; box-shadow: 0 0 0 1px #8b68342e; }
    .preview { display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
    .preview img { display: block; max-width: 100%; max-height: 560px; width: auto; height: auto; object-fit: contain; }
    .canvas[data-busy="true"] .preview { opacity: .65; }
    .placeholder { display: grid; place-items: center; opacity: .4; font-size: 26px; }
    .canvas[data-phase="generating"] .placeholder { animation: breathe 2s ease-in-out infinite; }
    .footer, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
    .footer { justify-content: space-between; contain: inline-size; padding-top: 8px; font-size: .76em; line-height: 1.6; }
    .footer:has(.status:empty):not(:has(.actions > :not([hidden]))) { display: none; }
    .scene:not([open]) + .footer { display: none; }
    :host([data-busy="true"]) .footer, .scene:not([open]) + .footer:has(.status[data-error="true"]) { display: flex; }
    .actions button, .actions a { display: inline-flex; align-items: center; min-height: 32px; padding: 0; border: 0; background: transparent; color: inherit; text-decoration: none; }
    .actions button:hover, .actions a:hover { text-decoration: underline; text-underline-offset: 5px; }
    .cancel, .status { opacity: .7; }
    .status { margin: 0; overflow-wrap: anywhere; }
    .status[data-error="true"] { opacity: 1; }
    [hidden] { display: none !important; }
    @keyframes breathe { 50% { opacity: .8; } }
    @media (prefers-reduced-motion: reduce) { .placeholder { animation: none !important; } }
    @media (max-width: 480px) { :host { --frame-inset: 6px; } .scene > summary { padding-inline: 80px; } .regenerate { right: 19px; width: 58px; font-size: 11px; } .scene > summary::after { right: 3px; } .frame-corner { width: 20px; height: 20px; } .footer { gap: 2px; } .status { flex-basis: 100%; } }
  </style>
  <figure>
    ${Array.from({ length: 4 }, () => `<svg class="frame-corner" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M1 25V6L6 1H25L22 4H8L4 8V22Z" fill="#c8aa71" stroke="#76572f" stroke-width=".7"/><path d="M2 22V7L7 2H22M6 20V9L9 6H20" stroke="#f6e2ae" stroke-width=".8"/><path d="m8 12 4-4 4 4-4 4Z" fill="#e5cd91" stroke="#8b6834" stroke-width=".8"/></svg>`).join('')}
    <details class="scene" open>
    <summary title="点击画题收起或展开图片"><span class="label">画题</span><span class="title"></span><button type="button" class="regenerate" title="再次生成此画题的图片">再次生图</button></summary>
    <div class="scene-body">
    <div class="canvas" hidden>
      <button type="button" class="preview" aria-label="全屏查看图片与历史" hidden><img></button>
      <span class="placeholder" aria-hidden="true">✦</span>
    </div>
    <button type="button" class="generate"><span class="ornament" aria-hidden="true">✦</span><span class="generate-label">生成图片</span></button>
    </div></details>
    <div class="footer">
      <div class="actions"><button type="button" class="cancel" hidden>取消排队</button><a class="download" hidden>保存图片</a></div>
      <p class="status" role="status" aria-live="polite"></p>
    </div>
  </figure>`;
    // The marker parser has already identified the bracketed summary as the title.
    root.querySelector('.title').textContent = summary;
    root.querySelector('.scene > summary').addEventListener('click', event => event.stopPropagation(), { signal });
    const button = root.querySelector('.generate');
    const regenerate = root.querySelector('.regenerate');
    regenerate.setAttribute('aria-label', `再次生图：${summary}`);
    regenerate.addEventListener('keydown', event => event.stopPropagation(), { signal });
    regenerate.addEventListener('keyup', event => event.stopPropagation(), { signal });
    button.setAttribute('aria-label', `生成图片：${summary}`);
    const buttonLabel = root.querySelector('.generate-label');
    const cancel = root.querySelector('.cancel');
    const status = root.querySelector('.status');
    const canvas = root.querySelector('.canvas');
    const preview = root.querySelector('.preview');
    const image = preview.querySelector('img');
    const placeholder = root.querySelector('.placeholder');
    const download = root.querySelector('.download');
    image.alt = summary;
    image.loading = 'lazy';
    image.decoding = 'async';
    const setImageSize = (width, height) => {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
            return;
        slot.style.setProperty('--image-ratio', String(width / height));
        // Preserve the current 560px display-height limit without making the frame 680px wide.
        slot.style.setProperty('--image-width', `${Math.min(width, 560 * width / height)}px`);
    };
    const refreshTheme = () => {
        if (!slot.isConnected)
            return;
        const color = pageButtonColor(slot);
        if (slot.style.getPropertyValue('--button-surface') !== color)
            slot.style.setProperty('--button-surface', color);
    };
    slot.addEventListener('pointerenter', refreshTheme, { signal });
    slot.addEventListener('focusin', refreshTheme, { signal });
    return { slot, root, button, buttonLabel, regenerate, cancel, status, canvas, preview, image, placeholder, download, refreshTheme, setImageSize };
}
