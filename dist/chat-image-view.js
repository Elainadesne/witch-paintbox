/** A borderless illustration that inherits the surrounding message's typography and color. */
export function createChatImageView(summary, signal) {
    const slot = document.createElement('span');
    slot.className = 'witch-paintbox-image';
    slot.contentEditable = 'false';
    const shadow = slot.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
    :host { display: block; width: min(100%, 680px); margin: 1.35em auto; color: inherit; font: inherit; text-indent: 0; text-align: left; }
    *, *::before, *::after { box-sizing: border-box; }
    figure { display: grid; gap: 12px; margin: 0; }
    figcaption { display: grid; gap: 4px; line-height: 1.6; overflow-wrap: anywhere; }
    .label { font-size: 10px; letter-spacing: .16em; opacity: .55; }
    .summary { font-size: .86em; }
    figcaption, .footer { width: min(100%, calc(560px * var(--image-ratio, 1.2143))); justify-self: center; }
    button, a { color: inherit; font: inherit; -webkit-tap-highlight-color: transparent; }
    button { border: 0; border-radius: 0; background: transparent; cursor: pointer; }
    button:disabled { opacity: .5; cursor: wait; }
    button:focus-visible, a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
    .canvas { display: grid; place-items: center; justify-self: center; width: min(100%, calc(560px * var(--image-ratio, .6842))); aspect-ratio: var(--image-ratio, .6842); overflow: hidden; background: color-mix(in srgb, currentColor 5%, transparent); border-radius: 3px; }
    .preview { display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 0; cursor: zoom-in; }
    .preview img { display: block; max-width: 100%; max-height: 560px; width: auto; height: auto; object-fit: contain; }
    .canvas[data-busy="true"] .preview { opacity: .65; }
    .placeholder { display: grid; place-items: center; opacity: .4; font-size: 26px; }
    .canvas[data-phase="generating"] .placeholder { animation: breathe 2s ease-in-out infinite; }
    .footer, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
    .footer { justify-content: space-between; font-size: .76em; line-height: 1.6; }
    .actions button, .actions a { display: inline-flex; align-items: center; min-height: 36px; padding: 4px 0; text-decoration: none; }
    .actions button:not(:disabled):hover, .actions a:hover { text-decoration: underline; text-underline-offset: 5px; }
    .generate { font-weight: 600; }
    .cancel, .status { opacity: .65; }
    .status { margin: 0; overflow-wrap: anywhere; }
    .status[data-error="true"] { opacity: 1; }
    .viewer { width: fit-content; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); padding: 0; border: 0; background: #17161b; color: #f5f2f8; box-shadow: 0 16px 64px #0006; }
    .viewer::backdrop { background: #09080bd9; }
    .viewer-bar { display: flex; justify-content: flex-end; padding: 4px 12px; }
    .viewer-bar button { min-width: 44px; min-height: 40px; padding: 4px 8px; }
    .viewer img { display: block; max-width: calc(100vw - 24px); max-height: calc(100dvh - 80px); width: auto; height: auto; object-fit: contain; }
    [hidden] { display: none !important; }
    @keyframes breathe { 50% { opacity: .8; } }
    @media (prefers-reduced-motion: reduce) { .placeholder { animation: none !important; } }
    @media (max-width: 480px) { :host { margin: 1em auto; } .footer { gap: 2px; } .status { flex-basis: 100%; } }
  </style>
  <figure>
    <figcaption><span class="label">场景配图</span><span class="summary"></span></figcaption>
    <div class="canvas" hidden>
      <button type="button" class="preview" aria-label="查看大图" hidden><img></button>
      <span class="placeholder" aria-hidden="true">✦</span>
    </div>
    <div class="footer">
      <div class="actions"><button type="button" class="generate">生成图片</button><button type="button" class="cancel" hidden>取消排队</button><a class="download" hidden>保存图片</a></div>
      <p class="status" role="status" aria-live="polite"></p>
    </div>
  </figure>
  <dialog class="viewer" aria-label="查看场景配图"><div class="viewer-bar"><button type="button">关闭</button></div><img></dialog>`;
    shadow.querySelector('.summary').textContent = summary;
    const button = shadow.querySelector('.generate');
    const cancel = shadow.querySelector('.cancel');
    const status = shadow.querySelector('.status');
    const canvas = shadow.querySelector('.canvas');
    const preview = shadow.querySelector('.preview');
    const image = preview.querySelector('img');
    const placeholder = shadow.querySelector('.placeholder');
    const download = shadow.querySelector('.download');
    const viewer = shadow.querySelector('.viewer');
    const largeImage = viewer.querySelector('img');
    image.alt = largeImage.alt = summary;
    image.loading = 'lazy';
    image.decoding = largeImage.decoding = 'async';
    preview.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (!image.getAttribute('src') || viewer.open)
            return;
        largeImage.src = image.src;
        viewer.showModal();
    }, { signal });
    viewer.querySelector('button').addEventListener('click', () => viewer.close(), { signal });
    viewer.addEventListener('click', event => {
        event.stopPropagation();
        if (event.target === viewer)
            viewer.close();
    }, { signal });
    viewer.addEventListener('close', () => largeImage.removeAttribute('src'), { signal });
    signal.addEventListener('abort', () => { viewer.close(); largeImage.removeAttribute('src'); }, { once: true });
    return { slot, button, cancel, status, canvas, preview, image, placeholder, download, closePreview: () => viewer.close() };
}
