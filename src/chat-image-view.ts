/** Match the surrounding page color while keeping the generation button's text white. */
function pageButtonColor(element: HTMLElement): string {
  const layers: number[][] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const color = getComputedStyle(parent).backgroundColor;
    if (!/^rgba?\(/.test(color)) continue;
    const values = color.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3) continue;
    const alpha = values[3] ?? 1;
    if (alpha <= 0) continue;
    layers.push([values[0], values[1], values[2], alpha]);
    if (alpha >= 1) break;
  }
  let background = [40, 40, 48];
  for (const [r, g, b, alpha] of layers.reverse()) {
    background = [r, g, b].map((value, index) => value * alpha + background[index] * (1 - alpha));
  }
  const luminance = (rgb: number[]) => rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  let button = background.map(value => Math.min(255, value + 18));
  while (1.05 / (luminance(button) + .05) < 4.5) button = button.map(value => value * .9);
  return `rgb(${button.map(Math.round).join(', ')})`;
}

export function createChatImageView(summary: string, signal: AbortSignal) {
  const slot = document.createElement('span');
  slot.className = 'witch-paintbox-image';
  slot.contentEditable = 'false';
  const root = slot.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { --button-surface: #45434e; display: block; width: min(100%, 680px); margin: .8em auto; color: inherit; font: inherit; text-indent: 0; text-align: left; }
    *, *::before, *::after { box-sizing: border-box; }
    figure { margin: 0; padding: 8px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 2%, transparent); }
    .scene > summary { position: relative; display: grid; gap: 2px; padding: 3px 24px; text-align: center; list-style: none; cursor: pointer; overflow-wrap: anywhere; }
    .scene > summary::-webkit-details-marker { display: none; }
    .scene > summary::after { content: '⌄'; position: absolute; right: 4px; top: 50%; transform: translateY(-50%); opacity: .6; }
    .scene[open] > summary::after { content: '⌃'; }
    .scene-body { display: grid; gap: 8px; padding-top: 8px; }
    .label { font-size: 10px; letter-spacing: .2em; opacity: .6; }
    .title { color: inherit; font: inherit; font-size: .95em; font-weight: 650; line-height: 1.65; text-wrap: balance; }
    button, a { font: inherit; -webkit-tap-highlight-color: transparent; }
    button { cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .generate { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; min-height: 44px; padding: 10px 16px; border: 1px solid #ffffff38; border-radius: 7px; background: var(--button-surface); color: #fff; font-size: .85em; font-weight: 650; letter-spacing: .04em; }
    .generate:not(:disabled):hover { filter: brightness(1.1); }
    .generate:disabled { opacity: 1; color: #fff; }
    .generate .ornament { font-size: 15px; opacity: .7; }
    .canvas { display: grid; place-items: center; justify-self: center; width: min(100%, calc(560px * var(--image-ratio, .6842))); aspect-ratio: var(--image-ratio, .6842); overflow: hidden; background: color-mix(in srgb, currentColor 5%, transparent); border-radius: 5px; }
    .preview { display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
    .preview img { display: block; max-width: 100%; max-height: 560px; width: auto; height: auto; object-fit: contain; }
    .canvas[data-busy="true"] .preview { opacity: .65; }
    .placeholder { display: grid; place-items: center; opacity: .4; font-size: 26px; }
    .canvas[data-phase="generating"] .placeholder { animation: breathe 2s ease-in-out infinite; }
    .footer, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
    .footer { justify-content: space-between; font-size: .76em; line-height: 1.6; }
    .footer:has(.status:empty):not(:has(.actions > :not([hidden]))) { display: none; }
    .actions button, .actions a { display: inline-flex; align-items: center; min-height: 32px; padding: 0; border: 0; background: transparent; color: inherit; text-decoration: none; }
    .actions button:hover, .actions a:hover { text-decoration: underline; text-underline-offset: 5px; }
    .cancel, .status { opacity: .7; }
    .status { margin: 0; overflow-wrap: anywhere; }
    .status[data-error="true"] { opacity: 1; }
    [hidden] { display: none !important; }
    @keyframes breathe { 50% { opacity: .8; } }
    @media (prefers-reduced-motion: reduce) { .placeholder { animation: none !important; } }
    @media (max-width: 480px) { figure { padding: 6px; } .footer { gap: 2px; } .status { flex-basis: 100%; } }
  </style>
  <figure>
    <details class="scene" open>
    <summary title="点击收起或展开图片"><span class="label">画题</span><span class="title"></span></summary>
    <div class="scene-body">
    <div class="canvas" hidden>
      <button type="button" class="preview" aria-label="全屏查看图片与历史" hidden><img></button>
      <span class="placeholder" aria-hidden="true">✦</span>
    </div>
    <button type="button" class="generate"><span class="ornament" aria-hidden="true">✦</span><span class="generate-label">生成图片</span></button>
    <div class="footer">
      <div class="actions"><button type="button" class="cancel" hidden>取消排队</button><a class="download" hidden>保存图片</a></div>
      <p class="status" role="status" aria-live="polite"></p>
    </div>
    </div></details>
  </figure>`;
  // The marker parser has already identified the bracketed summary as the title.
  root.querySelector('.title')!.textContent = summary;
  root.querySelector('.scene > summary')!.addEventListener('click', event => event.stopPropagation(), { signal });
  const button = root.querySelector<HTMLButtonElement>('.generate')!;
  button.setAttribute('aria-label', `生成图片：${summary}`);
  const buttonLabel = root.querySelector<HTMLElement>('.generate-label')!;
  const cancel = root.querySelector<HTMLButtonElement>('.cancel')!;
  const status = root.querySelector<HTMLParagraphElement>('.status')!;
  const canvas = root.querySelector<HTMLElement>('.canvas')!;
  const preview = root.querySelector<HTMLButtonElement>('.preview')!;
  const image = preview.querySelector('img')!;
  const placeholder = root.querySelector<HTMLElement>('.placeholder')!;
  const download = root.querySelector<HTMLAnchorElement>('.download')!;
  image.alt = summary;
  image.loading = 'lazy';
  image.decoding = 'async';
  const refreshTheme = () => {
    if (!slot.isConnected) return;
    const color = pageButtonColor(slot);
    if (slot.style.getPropertyValue('--button-surface') !== color) slot.style.setProperty('--button-surface', color);
  };
  slot.addEventListener('pointerenter', refreshTheme, { signal });
  slot.addEventListener('focusin', refreshTheme, { signal });
  return { slot, root, button, buttonLabel, cancel, status, canvas, preview, image, placeholder, download, refreshTheme };
}
