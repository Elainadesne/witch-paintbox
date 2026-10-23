import { bindLauncher } from './launcher.js';
import { bindLauncherMenu } from './launcher-menu.js';
import { bindChatImages } from './chat-images.js';
import { ImageConfig } from './image-config.js';
import { ModelConfig } from './model-config.js';
import { AnchorConfig } from './anchor-config.js';
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
  let connectionPage: PageId = 'image-api';
  const imageConfig = new ImageConfig();
  const modelConfig = new ModelConfig();
  const anchorConfig = new AnchorConfig();
  const controller = new AbortController();
  const { signal } = controller;
  const host = document.createElement('div');
  host.id = extensionId;
  const root = host.attachShadow({ mode: 'open' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../style.css', import.meta.url).href;
  root.innerHTML = `
    <button type="button" class="launcher" aria-label="打开${pluginName}菜单，可拖动调整位置"
      aria-haspopup="dialog" aria-expanded="false" title="点击打开菜单 · 拖动调整位置">绘</button>
    <dialog id="image-plugin-panel" class="panel" aria-labelledby="image-plugin-title">
      <div class="shell">
        <header class="window-header">
          <div><p class="eyebrow">魔女的绘图工坊</p><h1 id="image-plugin-title">${pluginName}</h1></div>
          <div class="header-actions">
            <nav class="api-switch" aria-label="接口类型" hidden>
              <button type="button" data-page="image-api">生图 API</button>
              <button type="button" data-page="model-api">模型 API</button>
            </nav>
            <button type="button" class="close-button" aria-label="关闭${pluginName}" title="关闭">×</button>
          </div>
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
  const apiSwitch = root.querySelector<HTMLElement>('.api-switch')!;
  const persist = () => saveSettings(context, settings);
  const launcherMenu = bindLauncherMenu(launcher, root, signal, () => openPanel(settings.rememberPage ? settings.lastPage : 'guide'));

  function openPanel(target: PageId) {
    if (panel.open) return;
    launcherMenu.close();
    navigate(target, false);
    panel.showModal();
    content.focus({ preventScroll: true });
  }

  function navigate(next: PageId, focus = true) {
    imageConfig.unmount();
    modelConfig.unmount();
    anchorConfig.unmount();
    page = next;
    const isConnection = page === 'image-api' || page === 'model-api';
    if (isConnection) connectionPage = page;
    sidebar.innerHTML = navigationView(page);
    sidebar.querySelector<HTMLButtonElement>('[data-page="image-api"]')!.dataset.page = connectionPage;
    apiSwitch.hidden = !isConnection;
    apiSwitch.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    content.innerHTML = pageView(page, settings);
    if (page === 'image-api') imageConfig.mount(content.querySelector<HTMLElement>('[data-image-settings]')!);
    if (page === 'features') anchorConfig.mount(content.querySelector<HTMLElement>('[data-anchor-settings]')!);
    if (page === 'model-api' || page === 'features') {
      modelConfig.mount(content.querySelector<HTMLElement>('[data-model-settings]')!, page === 'features' ? 'features' : 'model');
    }
    content.scrollTop = 0;
    settings.lastPage = page;
    persist();
    if (focus) content.focus({ preventScroll: true });
  }

  // Wait for the isolated styles before measuring the floating button.
  stylesheet.addEventListener('load', () => {
    host.hidden = false;
    bindChatImages(signal);
    const floating = bindLauncher(
      launcher,
      settings.rememberPosition ? settings.position : null,
      position => {
        if (!settings.rememberPosition) return;
        settings.position = position;
        persist();
      },
      launcherMenu.toggle,
      signal,
      launcherMenu.close,
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
      if (!(input instanceof HTMLInputElement) || !['rememberPage', 'rememberPosition'].includes(input.name)) return;
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
    imageConfig.maskKey();
    modelConfig.maskKey();
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus({ preventScroll: true });
  }, { signal });
  stylesheet.addEventListener('error', () => {
    console.error(`[${pluginName}] 样式加载失败，请检查扩展文件是否完整。`);
    controller.abort();
    imageConfig.destroy();
    modelConfig.destroy();
    anchorConfig.destroy();
    host.remove();
  }, { once: true, signal });
  window.addEventListener('pagehide', event => {
    imageConfig.maskKey();
    modelConfig.maskKey();
    if (event.persisted) return;
    controller.abort();
    imageConfig.destroy();
    modelConfig.destroy();
    anchorConfig.destroy();
    host.remove();
  }, { signal });

  host.hidden = true;
  document.body.append(host);
}

$(mount);
