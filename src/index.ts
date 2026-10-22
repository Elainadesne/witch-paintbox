import { bindLauncher } from './launcher.js';
import { isPageId, pluginName, type PageId } from './pages.js';
import { defaultSettings, extensionId, readSettings, saveSettings, type TavernContext } from './settings.js';
import { navigationView, pageView } from './views.js';

declare const SillyTavern: { getContext(): TavernContext };
declare const $: (ready: () => void) => void;

function mount() {
  if (document.getElementById(extensionId)) return;
  const context = SillyTavern.getContext();
  let settings = readSettings(context);
  let page: PageId = 'guide';
  const controller = new AbortController();
  const { signal } = controller;
  const host = document.createElement('div');
  host.id = extensionId;
  const root = host.attachShadow({ mode: 'open' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../style.css', import.meta.url).href;
  root.innerHTML = `
    <button type="button" class="launcher" aria-label="打开${pluginName}，可拖动调整位置"
      aria-haspopup="dialog" aria-controls="image-plugin-panel" aria-expanded="false" title="打开${pluginName} · 拖动调整位置">绘</button>
    <dialog id="image-plugin-panel" class="panel" aria-labelledby="image-plugin-title">
      <div class="shell">
        <header class="window-header">
          <div><p class="eyebrow">小魔女的绘图工坊</p><h1 id="image-plugin-title">${pluginName}</h1></div>
          <button type="button" class="close-button" aria-label="关闭${pluginName}" title="关闭">×</button>
        </header>
        <div class="workspace">
          <nav class="sidebar" aria-label="插件导航"></nav>
          <main class="content" tabindex="-1"></main>
        </div>
      </div>
    </dialog>`;
  root.prepend(stylesheet);

  const launcher = root.querySelector<HTMLButtonElement>('.launcher')!;
  const panel = root.querySelector<HTMLDialogElement>('.panel')!;
  const sidebar = root.querySelector<HTMLElement>('.sidebar')!;
  const content = root.querySelector<HTMLElement>('.content')!;
  const persist = () => saveSettings(context, settings);

  function navigate(next: PageId, focus = true) {
    page = next;
    sidebar.innerHTML = navigationView(page);
    content.innerHTML = pageView(page, settings);
    content.scrollTop = 0;
    settings.lastPage = page;
    persist();
    if (focus) content.focus({ preventScroll: true });
  }

  // Wait for the isolated styles before measuring the floating button.
  stylesheet.addEventListener('load', () => {
    host.hidden = false;
    const floating = bindLauncher(
      launcher,
      settings.rememberPosition ? settings.position : null,
      position => {
        if (!settings.rememberPosition) return;
        settings.position = position;
        persist();
      },
      () => {
        if (panel.open) return;
        navigate(settings.rememberPage ? settings.lastPage : 'guide', false);
        panel.showModal();
        launcher.setAttribute('aria-expanded', 'true');
        content.focus({ preventScroll: true });
      },
      signal,
    );
    root.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('button');
      if (!button) return;
      if (isPageId(button.dataset.page)) navigate(button.dataset.page);
      if (button.classList.contains('close-button')) panel.close();
      if (button.dataset.action === 'reset-preferences') {
        settings = defaultSettings();
        floating.reset();
        persist();
        content.innerHTML = pageView(page, settings);
        content.querySelector<HTMLElement>('[data-feedback]')!.textContent = '已恢复默认偏好。';
        content.querySelector<HTMLButtonElement>('[data-action="reset-preferences"]')!.focus();
      }
    }, { signal });

    root.addEventListener('change', event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.name === 'rememberPage') {
        settings.rememberPage = input.checked;
        settings.lastPage = page;
      }
      if (input.name === 'rememberPosition') {
        settings.rememberPosition = input.checked;
        settings.position = input.checked ? floating.getPosition() : null;
      }
      persist();
      content.querySelector<HTMLElement>('[data-feedback]')!.textContent = '更改会自动保存。';
    }, { signal });
  }, { once: true, signal });

  panel.addEventListener('close', () => {
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus({ preventScroll: true });
  }, { signal });
  stylesheet.addEventListener('error', () => {
    console.error(`[${pluginName}] 样式加载失败，请检查扩展文件是否完整。`);
    controller.abort();
    host.remove();
  }, { once: true, signal });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    controller.abort();
    host.remove();
  }, { signal });

  host.hidden = true;
  document.body.append(host);
}

$(mount);
