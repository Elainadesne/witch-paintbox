import { tavernIsDark } from './paintbox-theme.js';
import { currentPreferences } from './settings.js';
/** Tallest a picture is shown in the chat, in CSS pixels; narrow chats shrink it further. */
const DISPLAY_HEIGHT = 760;
/** The frame follows the paintbox's day/night preference, like the main panel. */
function frameTheme() {
    try {
        const wanted = currentPreferences().paintboxTheme;
        return wanted === 'night' || (wanted === 'auto' && tavernIsDark()) ? 'night' : 'day';
    }
    catch {
        return 'day';
    }
}
export function createChatImageView(summary, signal) {
    const slot = document.createElement('div');
    slot.className = 'witch-paintbox-image';
    slot.contentEditable = 'false';
    slot.dataset.preserveHtml = '1';
    slot.addEventListener('click', event => event.stopPropagation(), { signal });
    const root = slot.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
    /* 「颜料未干」的一页画稿：水彩纸、棕墨线、楷体画题，与画匣主面板同一套纸墨。 */
    :host {
      --paper: #f7f0e3; --paper-deep: #efe4d0; --ink: #3a2416; --ink-soft: #6e4730; --muted: #8a7563;
      --pencil: #3a24163a; --wash: #e6872a; --wash-ink: color-mix(in oklab, var(--wash) 62%, #3a2416);
      --wash-soft: color-mix(in oklab, var(--wash) 22%, transparent); --mat: #fbf6ec; --grain-blend: multiply; --grain-opacity: 1;
      --serif: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, serif;
      --kai: "AR PL UKai CN", KaiTi, STKaiti, "Kaiti SC", var(--serif);
      --ease: cubic-bezier(.16, 1, .3, 1);
      --frame-inset: 14px; --image-width: 507px; --image-ratio: .6667;
      display: block; box-sizing: border-box; width: max-content;
      min-width: min(100%, calc(min(var(--image-width), 78vh * var(--image-ratio)) + var(--frame-inset) * 2));
      max-width: 100%; margin: 1.1em auto; color: var(--ink); font: inherit; text-indent: 0; text-align: left;
    }
    :host([data-theme="night"]) {
      --paper: #2b2018; --paper-deep: #21170f; --ink: #efe1c8; --ink-soft: #d9c3a3; --muted: #b7a185;
      --pencil: #efe1c83d; --wash: #f0a85a; --wash-ink: color-mix(in oklab, var(--wash) 78%, #fff3dd);
      --wash-soft: color-mix(in oklab, var(--wash) 24%, transparent); --mat: #33261c; --grain-blend: screen; --grain-opacity: .5;
    }
    *, *::before, *::after { box-sizing: border-box; }
    /* 纸：底色与颗粒都在伪元素上，毛边用多边形裁出 */
    figure { position: relative; isolation: isolate; width: 100%; min-width: 0; max-width: 100%; margin: 0; padding: var(--frame-inset); padding-bottom: calc(var(--frame-inset) - 4px); filter: drop-shadow(0 6px 10px #2a180b2e) drop-shadow(0 1px 1px #2a180b24); }
    figure::before, figure::after { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; clip-path: var(--deckle); }
    figure::before { background: radial-gradient(120% 80% at 15% 0%, var(--mat) 0%, transparent 60%), radial-gradient(90% 80% at 100% 100%, var(--paper-deep) 0%, transparent 70%), var(--paper); }
    figure::after { opacity: var(--grain-opacity); mix-blend-mode: var(--grain-blend); background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 .23 0 0 0 0 .14 0 0 0 0 .09 0 0 0 .08 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
    :host([data-theme="night"]) figure::after { filter: invert(1); }
    :host { --deckle: polygon(0% 3px, 5.56% 3.1px, 11.11% 2.9px, 16.67% .6px, 22.22% 2.1px, 27.78% 1.6px, 33.33% 1.9px, 38.89% .8px, 44.44% .9px, 50% 1.6px, 55.56% 1px, 61.11% 1.7px, 66.67% .5px, 72.22% .6px, 77.78% 2.4px, 83.33% 1.6px, 88.89% 1.8px, 94.44% 2.5px, calc(100% - 1.4px) 0%, calc(100% - .6px) 5.56%, calc(100% - 2.6px) 11.11%, calc(100% - 2px) 16.67%, calc(100% - 2.2px) 22.22%, calc(100% - 2.1px) 27.78%, calc(100% - 3.1px) 33.33%, calc(100% - 1.4px) 38.89%, calc(100% - 2.5px) 44.44%, calc(100% - 1.4px) 50%, calc(100% - 2px) 55.56%, calc(100% - 2.2px) 61.11%, calc(100% - 1.3px) 66.67%, calc(100% - .6px) 72.22%, calc(100% - 1.7px) 77.78%, calc(100% - 2.4px) 83.33%, calc(100% - 2.1px) 88.89%, calc(100% - 1.7px) 94.44%, 100% calc(100% - 2.2px), 94.44% calc(100% - .9px), 88.89% calc(100% - .9px), 83.33% calc(100% - 1.3px), 77.78% calc(100% - 2.7px), 72.22% calc(100% - .9px), 66.67% calc(100% - .7px), 61.11% calc(100% - .7px), 55.56% calc(100% - .5px), 50% calc(100% - 1.2px), 44.44% calc(100% - 2px), 38.89% calc(100% - 2.7px), 33.33% calc(100% - 1.3px), 27.78% calc(100% - 1.4px), 22.22% calc(100% - 1.2px), 16.67% calc(100% - 1.3px), 11.11% calc(100% - 2.6px), 5.56% calc(100% - 1.9px), 1.1px 100%, .7px 94.44%, 2.6px 88.89%, 2.4px 83.33%, 2.7px 77.78%, 1.1px 72.22%, 1.9px 66.67%, 3px 61.11%, 2.1px 55.56%, 3px 50%, .9px 44.44%, 3.1px 38.89%, .6px 33.33%, 1.6px 27.78%, .5px 22.22%, 2.7px 16.67%, 2.3px 11.11%, 3.1px 5.56%); }
    /* 一条斜贴的纸胶带，颜色取当前颜料 */
    .tape { position: absolute; z-index: 2; top: -9px; left: 50%; width: 104px; height: 22px; pointer-events: none; background: repeating-linear-gradient(90deg, #ffffff2e 0 6px, transparent 6px 13px), color-mix(in oklab, var(--wash) 82%, transparent); clip-path: polygon(3% 8%, 97% 0, 100% 50%, 96% 100%, 2% 92%, 0 45%); transform: translateX(-50%) rotate(-2.5deg); box-shadow: 0 2px 4px #120a0540; opacity: .92; }
    .scene, .footer { position: relative; min-width: 0; }
    .scene { width: 100%; max-width: 100%; }
    .scene > summary { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 14px; min-width: 0; padding: 6px 2px 10px; list-style: none; cursor: pointer; overflow-wrap: anywhere; }
    .scene > summary::-webkit-details-marker { display: none; }
    .heading { display: grid; gap: 3px; min-width: 0; }
    .label { display: flex; align-items: center; gap: 8px; color: var(--wash-ink); font: 12px/1 var(--kai); letter-spacing: .4em; }
    .label::after { content: '▾'; font-size: 10px; letter-spacing: 0; opacity: .7; transition: transform 320ms var(--ease); }
    .scene:not([open]) .label::after { transform: rotate(-90deg); }
    .title { color: var(--ink); font: 500 1.06em/1.6 var(--kai); letter-spacing: .08em; text-wrap: balance; }
    /* 画题下的一道干刷，代替分隔线 */
    .scene > summary::after { content: ''; position: absolute; left: 0; right: 0; bottom: 2px; height: 2px; border-radius: 2px; background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--ink-soft) 55%, transparent) 12%, color-mix(in oklab, var(--ink-soft) 30%, transparent) 70%, transparent); pointer-events: none; }
    .scene:not([open]) > summary::after { opacity: .5; }
    button, a { font: inherit; -webkit-tap-highlight-color: transparent; }
    button { cursor: pointer; }
    button:disabled { cursor: wait; }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px dashed var(--ink); outline-offset: 3px; }
    /* 再次生图：一行带下划线的墨字 */
    .regenerate { position: relative; justify-self: end; min-height: 32px; padding: 4px 2px; border: 0; border-radius: 0; background: linear-gradient(currentColor, currentColor) 0 calc(100% - 4px) / 100% 1px no-repeat; color: var(--wash-ink); font: 13px/1.4 var(--kai); letter-spacing: .14em; white-space: nowrap; transition: transform 160ms ease, color 160ms ease; }
    .regenerate:hover:not(:disabled) { color: var(--ink); transform: translateY(-1px); }
    .regenerate:disabled { color: var(--muted); background-size: 0 1px; }
    .scene-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; width: 100%; padding-top: 12px; min-width: 0; contain: inline-size; }
    /* 生成按钮：一团颜料，悬停时颜料加浓铺开 */
    .generate { position: relative; isolation: isolate; display: flex; align-items: center; justify-content: center; gap: 10px; justify-self: center; width: min(100%, 300px); min-width: 0; min-height: 46px; margin: 4px 0 6px; padding: 10px 26px; border: 0; background: transparent; color: #fffaf0; font: 500 .92em/1.3 var(--kai); letter-spacing: .22em; transition: transform 160ms ease; }
    .generate::before { content: ''; position: absolute; inset: 0 -4px; z-index: -1; pointer-events: none; background: var(--wash); border-radius: 46% 54% 40% 60% / 60% 46% 54% 40%; box-shadow: inset 0 -6px 10px color-mix(in oklab, var(--wash) 60%, #3a2416), 0 2px 3px #3a241622; transition: transform 320ms var(--ease), filter 320ms ease; }
    .generate:hover:not(:disabled) { transform: translateY(-1px); }
    .generate:hover:not(:disabled)::before { transform: scale(1.05, 1.1); filter: saturate(1.15); }
    .generate:active:not(:disabled) { transform: translateY(1px) scale(1.04, .94); }
    .generate:disabled { color: #6e5a48; }
    .generate:disabled::before { background: #d6c8b1; box-shadow: none; }
    :host([data-theme="night"]) .generate { color: #2b1a0f; }
    :host([data-theme="night"]) .generate::before { box-shadow: inset 0 -6px 10px color-mix(in oklab, var(--wash) 70%, #3a2416); }
    :host([data-theme="night"]) .generate:disabled { color: #b7a185; }
    :host([data-theme="night"]) .generate:disabled::before { background: #4a382a; }
    .generate .ornament { font-size: 14px; opacity: .75; }
    /* 画心：衬一层浅纸，铅笔描一圈，像裱在画稿上 */
    .canvas { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; justify-self: center; width: min(100%, var(--image-width), calc(78vh * var(--image-ratio))); max-width: 100%; min-width: 0; min-height: 0; aspect-ratio: var(--image-ratio); overflow: hidden; background: color-mix(in oklab, var(--paper-deep) 80%, var(--ink) 6%); box-shadow: 0 0 0 1px var(--pencil), 0 0 0 5px var(--mat), 0 0 0 6px color-mix(in oklab, var(--pencil) 70%, transparent), 0 3px 8px 6px #2a180b14; margin: 6px 0; }
    .preview { position: absolute; inset: 0; display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
    .preview img { display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; max-width: 100%; max-height: 100%; margin: 0; object-fit: contain; transition: opacity .9s var(--ease), filter .9s var(--ease); }
    .canvas.veiled .preview img { opacity: 0; transition: none; }
    .canvas[data-busy="true"] .preview img { opacity: .55; filter: saturate(.6) blur(1px); }
    /* 绘制中：一抹颜料在纸上洇开又收拢 */
    .placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: var(--wash-ink); font-size: 24px; opacity: .55; }
    .placeholder::before { content: ''; position: absolute; width: 42%; aspect-ratio: 1.4; border-radius: 46% 54% 40% 60% / 60% 46% 54% 40%; background: var(--wash-soft); }
    .canvas[data-phase="generating"] .placeholder::before { animation: bloom 2.6s ease-in-out infinite; }
    .canvas[data-phase="generating"] .placeholder { animation: breathe 2.6s ease-in-out infinite; }
    .footer, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 18px; }
    .footer { justify-content: space-between; contain: inline-size; padding: 4px 2px 0; color: var(--muted); font: .8em/1.6 var(--kai); letter-spacing: .06em; }
    .footer:has(.status:empty):not(:has(.actions > :not([hidden]))) { display: none; }
    .scene:not([open]) + .footer { display: none; }
    :host([data-busy="true"]) .footer, .scene:not([open]) + .footer:has(.status[data-error="true"]) { display: flex; }
    .actions button, .actions a { display: inline-flex; align-items: center; min-height: 32px; padding: 0 2px; border: 0; background: linear-gradient(currentColor, currentColor) 0 calc(100% - 6px) / 0 1px no-repeat; color: var(--ink-soft); text-decoration: none; letter-spacing: .12em; transition: background-size 320ms var(--ease), color 160ms ease; }
    .actions button:hover, .actions a:hover { color: var(--ink); background-size: 100% 1px; }
    .status { margin: 0; overflow-wrap: anywhere; }
    .status[data-error="true"] { color: #a3463e; }
    :host([data-theme="night"]) .status[data-error="true"] { color: #ef8a7c; }
    [hidden] { display: none !important; }
    @keyframes breathe { 50% { opacity: .9; } }
    @keyframes bloom { 0%, 100% { transform: scale(.7) rotate(0deg); opacity: .6; } 50% { transform: scale(1.25) rotate(8deg); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .placeholder, .placeholder::before { animation: none !important; } .preview img { transition: none; } }
    @media (max-width: 480px) { :host { --frame-inset: 10px; } .tape { width: 84px; height: 18px; top: -7px; } .title { font-size: 1em; } .footer { gap: 2px 14px; } .status { flex-basis: 100%; } }
  </style>
  <figure>
    <span class="tape" aria-hidden="true"></span>
    <details class="scene" open>
    <summary title="点击画题收起或展开图片"><span class="heading"><span class="label">画题</span><span class="title"></span></span><button type="button" class="regenerate" title="再次生成此画题的图片">再次生图</button></summary>
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
        // Cap the shown height, never upscale past the picture's own width; the chat width narrows it further.
        slot.style.setProperty('--image-width', `${Math.min(width, DISPLAY_HEIGHT * width / height)}px`);
    };
    const refreshTheme = () => {
        if (!slot.isConnected)
            return;
        const theme = frameTheme();
        if (slot.dataset.theme !== theme)
            slot.dataset.theme = theme;
    };
    // The desktop pet hides a new picture while it flies in; the frame shows it again after 4 s at the latest.
    let veils = 0;
    const veil = () => {
        const current = ++veils;
        canvas.classList.add('veiled');
        const release = () => { if (veils === current)
            canvas.classList.remove('veiled'); };
        setTimeout(release, 4000);
        return release;
    };
    slot.addEventListener('pointerenter', refreshTheme, { signal });
    slot.addEventListener('focusin', refreshTheme, { signal });
    return { slot, root, button, buttonLabel, regenerate, cancel, status, canvas, preview, image, placeholder, download, refreshTheme, setImageSize, veil };
}
