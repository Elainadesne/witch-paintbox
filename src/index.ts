import { bindLauncher } from './launcher.js';
import { bindLauncherMenu } from './launcher-menu.js';
import { bindChatImages } from './chat-images.js';
import { ImageConfig } from './image-config.js';
import { ModelConfig } from './model-config.js';
import { AnchorConfig } from './anchor-config.js';
import { ConfigTransfer } from './config-transfer.js';
import { registerBuiltinLayers } from './builtin-layers.js';
import { bindContextFilter } from './context-filter.js';
import { isPageId, pluginName, type PageId } from './pages.js';
import { defaultSettings, extensionId, isPaintboxTheme, readPetScale, readSettings, saveSettings, type TavernContext } from './settings.js';
import { bindPaintboxTheme } from './paintbox-theme.js';
import { guideDestination, navigationView, pageView, type FeatureTab, type GuideDestination } from './views.js';
import { getHostStore, initializeHostStorage } from './host-storage.js';
import { getSyncApiKeys, initializeSettingsStorage, setSyncApiKeys } from './host-settings.js';
import { initializeNativeLibraries } from './host-library.js';
import { bindUpdateNotice, updateNoticeView } from './extension-updates.js';
import { ImageReview } from './image-review.js';
import { bindImageRetention, imageRetentionStatus } from './image-retention.js';
import { bindImageHistorySync } from './image-history.js';
import { bindSettingsEntry } from './settings-entry.js';
import { bindSifangWindowViewport, isSifangEnvironment } from './sifang-host.js';
import { initializeSifangChat } from './sifang-chat.js';
import { bindSifangImages } from './sifang-images.js';
import { bindPet, type PetHandle } from './pet/index.js';
import { emitPetEvent } from './pet-events.js';
import { bindPanelViewport } from './panel-viewport.js';

declare const SillyTavern: { getContext(): TavernContext };
declare const $: (ready: () => void) => void;

async function mount() {
  if (document.getElementById(extensionId)) return;
  await initializeHostStorage();
  await Promise.all([initializeSettingsStorage(), initializeNativeLibraries()]);
  const unregisterLayers = registerBuiltinLayers();
  const context = SillyTavern.getContext();
  let settings = readSettings(context);
  let page: PageId = 'guide';
  let connectionPage: PageId = 'image-api';
  let featureTab: FeatureTab = 'anchors';
  const imageConfig = new ImageConfig();
  const modelConfig = new ModelConfig();
  const imageReview = new ImageReview();
  let anchorConfig = new AnchorConfig();
  let floating: ReturnType<typeof bindLauncher> | PetHandle | null = null;
  let pet: PetHandle | null = null;
  let changingSyncKeys = false;
  const transfer = new ConfigTransfer(context, (kind, provider) => {
    if (kind === 'all' || kind === 'artists') imageConfig.reloadSaved(kind === 'artists');
    if (kind === 'presets') modelConfig.reloadSaved(kind, provider);
    if (kind === 'worldbooks') {
      modelConfig.reloadSaved('worldbooks', 'novelai');
      modelConfig.reloadSaved('worldbooks', 'openai');
    }
    if (kind === 'all') {
      modelConfig.reloadSaved();
      anchorConfig.destroy(); anchorConfig = new AnchorConfig();
      settings = readSettings(context);
      if (pet && settings.rememberPosition && settings.petPlacement) pet.setPlacement(settings.petPlacement);
      else if (settings.rememberPosition && settings.position) floating?.setPosition(settings.position);
      else floating?.reset();
      for (const input of Array.from(content.querySelectorAll<HTMLInputElement>('.preference-row input'))) {
        if (input.name === 'rememberPage' || input.name === 'rememberPosition' || input.name === 'autoGenerateImages'
          || input.name === 'petLines' || input.name === 'petMotion') input.checked = settings[input.name];
      }
      const retention = content.querySelector<HTMLSelectElement>('[name="imageRetentionDays"]');
      if (retention) retention.value = String(settings.imageRetentionDays);
      const theme = content.querySelector<HTMLSelectElement>('[name="paintboxTheme"]');
      if (theme) theme.value = settings.paintboxTheme;
      syncPetScale();
      // applyArchive emits before this callback reloads the live preferences.
      window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
    }
  }, () => imageConfig.hasPendingWrites || modelConfig.hasPendingWrites || anchorConfig.hasPendingWrites || changingSyncKeys ? '配置仍在保存或角色图仍在生成，请完成后再导入或导出。' : undefined);
  const controller = new AbortController();
  const { signal } = controller;
  let nativeReady = false;
  let nativeError = '';
  if (isSifangEnvironment()) {
    await bindSifangWindowViewport(signal).catch(error => console.warn(`[${pluginName}] 无法扩展插件窗口范围。`, error));
    try { await initializeSifangChat(signal); nativeReady = true; }
    catch (error) { nativeError = error instanceof Error ? error.message : '独立前端接口未能初始化，请检查前端与画匣版本。'; }
  }
  bindImageHistorySync(signal);
  bindImageRetention(signal);
  signal.addEventListener('abort', unregisterLayers, { once: true });
  bindContextFilter(signal);
  const host = document.createElement('div');
  host.id = extensionId;
  const root = host.attachShadow({ mode: 'open' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../style.css', import.meta.url).href;
  root.innerHTML = `
    <svg class="paint-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="wp-deckle" x="-2%" y="-2%" width="104%" height="104%">
        <feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="7" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
      <filter id="wp-bleed" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency=".022" numOctaves="2" seed="3" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="14" xChannelSelector="R" yChannelSelector="B" result="d"/>
        <feGaussianBlur in="d" stdDeviation=".8"/>
      </filter>
    </svg>
    <button type="button" class="launcher" aria-label="打开${pluginName}菜单，可拖动调整位置"
      aria-haspopup="dialog" aria-expanded="false" title="点击打开菜单 · 拖动调整位置">绘</button>
    <dialog id="image-plugin-panel" class="panel" aria-labelledby="image-plugin-title">
      <div class="shell">
        <header class="window-header">
          <div class="window-brand"><p class="eyebrow">魔女的绘图工坊</p>
            <div class="window-title"><h1 id="image-plugin-title">${pluginName}</h1>${updateNoticeView()}</div>
          </div>
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
  let panelOpener: HTMLElement = launcher;
  const panel = root.querySelector<HTMLDialogElement>('.panel')!;
  const panelViewport = bindPanelViewport(panel, signal);
  const sidebar = root.querySelector<HTMLElement>('.sidebar')!;
  const content = root.querySelector<HTMLElement>('.content')!;
  const apiSwitch = root.querySelector<HTMLElement>('.api-switch')!;
  const updateNotice = bindUpdateNotice(root, signal);
  const persist = () => saveSettings(context, settings);
  const refreshTheme = bindPaintboxTheme(host, () => settings.paintboxTheme, signal);
  // 指定插图窗会直接改排除标签；主面板之后保存其他偏好时不能把它写回旧值
  window.addEventListener('witch-paintbox:preferences-changed', () => { settings.excludedTags = readSettings(context).excludedTags; }, { signal });
  function syncPetScale() {
    const percent = Math.round(settings.petScale * 100);
    const input = content.querySelector<HTMLInputElement>('[name="petScale"]');
    if (input) { input.value = String(percent); input.setAttribute('aria-valuetext', `${percent}%`); }
    const output = content.querySelector<HTMLOutputElement>('[data-pet-scale-value]');
    if (output) output.value = `${percent}%`;
  }
  function setPetScale(value: number) {
    if (transfer.isApplying) { syncPetScale(); return; }
    const next = readPetScale(value);
    if (settings.petScale !== next) { settings.petScale = next; persist(); }
    syncPetScale();
  }
  const showCleanupStatus = () => {
    const status = content.querySelector<HTMLElement>('[data-cleanup-status]');
    if (status) status.textContent = imageRetentionStatus();
  };
  window.addEventListener('witch-paintbox:cleanup-status', showCleanupStatus, { signal });
  window.addEventListener('resize', () => { if (panel.open) paintNavigation(); }, { signal });
  const launcherMenu = bindLauncherMenu(launcher, root, signal, from => openPanel(settings.rememberPage ? settings.lastPage : 'guide', launcher, from), {
    anchor: () => pet?.anchor() ?? launcher.getBoundingClientRect(),
    box: () => pet?.box() ?? launcher.getBoundingClientRect(),
  });

  function openPanel(target: PageId, opener: HTMLElement = launcher, from?: DOMRect) {
    if (panel.open) return;
    panelOpener = opener;
    launcherMenu.close();
    navigate(target, false);
    panel.classList.remove('is-opening');
    void panel.offsetWidth;
    panel.classList.add('is-opening');
    window.setTimeout(() => panel.classList.remove('is-opening'), 320);
    panel.showModal();
    panelViewport.refresh();
    placeBloomOrigin(from ?? (opener === launcher ? undefined : opener.getBoundingClientRect()));
    paintNavigation();
    emitPetEvent({ type: 'ui', action: 'panel-open' });
    updateNotice.check();
    content.focus({ preventScroll: true });
  }

  // 开场晕染从点击处开始：菜单里的“设置”、酒馆设置里的入口按钮；都没有时取悬浮球。
  // 点位夹在面板范围内，远处的起点只会落在面板最近的边上。
  function placeBloomOrigin(from?: DOMRect) {
    const box = panel.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const source = from && from.width ? from : launcher.getBoundingClientRect();
    const cx = source.width ? source.x + source.width / 2 : box.right;
    const cy = source.height ? source.y + source.height / 2 : box.bottom;
    const x = Math.min(1, Math.max(0, (cx - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (cy - box.top) / box.height));
    panel.style.setProperty('--bloom-x', `${(x * 100).toFixed(1)}%`);
    panel.style.setProperty('--bloom-y', `${(y * 100).toFixed(1)}%`);
  }

  function revealSection(selector: string) {
    const target = content.querySelector<HTMLElement>(selector);
    if (!target) return;
    if (!target.matches('button, input, select, textarea, [tabindex]')) target.tabIndex = -1;
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  }

  // 选中板块的颜料色块与主色；从旧位置滑过来时留一道渐淡的拖痕
  function paintNavigation(fromTop?: number, fromPaint?: string) {
    const current = sidebar.querySelector<HTMLElement>('.nav-item[aria-current="page"]');
    const mark = sidebar.querySelector<HTMLElement>('.wash-mark');
    if (!current || !mark) return;
    const paint = current.style.getPropertyValue('--c');
    panel.style.setProperty('--wash', paint);
    const place = () => {
      const top = current.offsetTop, left = current.offsetLeft;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!still && fromTop !== undefined && fromTop !== top && current.offsetHeight) {
        mark.style.transition = 'none';
        mark.style.top = `${fromTop}px`;
        if (fromPaint) mark.style.backgroundColor = fromPaint;
        void mark.offsetWidth;
        mark.style.transition = '';
        const trail = document.createElement('i');
        trail.className = 'wash-trail';
        trail.setAttribute('aria-hidden', 'true');
        trail.style.top = `${Math.min(fromTop, top) + current.offsetHeight / 2 - 4}px`;
        trail.style.height = `${Math.abs(top - fromTop) + 8}px`;
        trail.style.left = `${left + 14}px`;
        if (fromPaint) trail.style.backgroundColor = fromPaint;
        sidebar.prepend(trail);
        trail.addEventListener('animationend', () => trail.remove(), { once: true });
        window.setTimeout(() => trail.remove(), 1200);
      }
      mark.style.top = `${top}px`;
      mark.style.left = `${left}px`;
      mark.style.width = `${current.offsetWidth}px`;
      mark.style.height = `${current.offsetHeight}px`;
      mark.style.backgroundColor = '';
      mark.dataset.top = String(top);
    };
    if (current.offsetHeight) place();
    else requestAnimationFrame(place);
  }

  function navigate(next: PageId, focus = true, nextFeatureTab?: FeatureTab, destination?: GuideDestination) {
    if (transfer.isApplying || changingSyncKeys) return;
    imageConfig.unmount();
    modelConfig.unmount();
    imageReview.unmount();
    anchorConfig.unmount();
    transfer.unmount();
    page = next;
    if (page === 'features' && nextFeatureTab) featureTab = nextFeatureTab;
    const isConnection = page === 'image-api' || page === 'model-api';
    if (isConnection) connectionPage = page;
    const previousMark = sidebar.querySelector<HTMLElement>('.wash-mark');
    const fromTop = previousMark?.dataset.top;
    const fromPaint = panel.style.getPropertyValue('--wash');
    sidebar.innerHTML = navigationView(page);
    sidebar.querySelector<HTMLButtonElement>('[data-page="image-api"]')!.dataset.page = connectionPage;
    paintNavigation(fromTop === undefined ? undefined : Number(fromTop), fromPaint);
    apiSwitch.hidden = !isConnection;
    apiSwitch.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    content.innerHTML = pageView(page, settings, featureTab);
    content.classList.remove('is-fresh');
    void content.offsetWidth;
    content.classList.add('is-fresh');
    const imageContainer = content.querySelector<HTMLElement>('[data-image-settings]');
    const anchorContainer = content.querySelector<HTMLElement>('[data-anchor-settings]');
    const modelContainer = content.querySelector<HTMLElement>('[data-model-settings]');
    if (page === 'image-api' && imageContainer) imageConfig.mount(imageContainer);
    if (page === 'features' && anchorContainer) anchorConfig.mount(anchorContainer, destination?.anchorTab);
    if (page === 'model-api' || page === 'features') {
      if (modelContainer) modelConfig.mount(modelContainer, page === 'model-api' ? 'model' : featureTab === 'worldbook' ? 'worldbook' : 'features');
    }
    const transferContainer = content.querySelector<HTMLElement>('[data-config-transfer]');
    if (page === 'preferences' && transferContainer) transfer.mount(transferContainer);
    const reviewContainer = content.querySelector<HTMLElement>('[data-image-review]');
    if (page === 'review' && reviewContainer) imageReview.mount(reviewContainer, destination?.reviewScope);
    showCleanupStatus();
    content.scrollTop = 0;
    settings.lastPage = page;
    persist();
    if (focus) content.focus({ preventScroll: true });
    if (destination?.selector) revealSection(destination.selector);
  }

  // Wait for the isolated styles before measuring the floating button.
  stylesheet.addEventListener('load', () => {
    host.hidden = false;
    bindSettingsEntry(button => openPanel(settings.rememberPage ? settings.lastPage : 'guide', button), signal);
    if (nativeReady) bindSifangImages(root, signal);
    else if (!isSifangEnvironment()) bindChatImages(signal);
    if (nativeError) {
      const toast = (window as Window & { toastr?: { error(message: string): void } }).toastr;
      if (toast) toast.error(nativeError);
      else console.error(`[${pluginName}] ${nativeError}`);
    }
    try {
      pet = bindPet({
        root, launcher, signal,
        initial: settings.rememberPosition ? settings.position : null,
        placement: settings.rememberPosition ? settings.petPlacement : null,
        preferences: () => ({ lines: settings.petLines, motion: settings.petMotion, scale: settings.petScale, away: settings.petAway }),
        onMove(position, placement) {
          if (!settings.rememberPosition || transfer.isApplying) return;
          settings.position = position;
          settings.petPlacement = placement;
          persist();
        },
        onAway(away) { settings.petAway = away; persist(); },
        onOpen: launcherMenu.toggle,
        onDrag: launcherMenu.close,
      });
    } catch (error) {
      // (the old floating ball takes over)
      console.error(`[${pluginName}] 桌宠加载失败，已换回悬浮球。`, error);
      pet = null;
    }
    floating = pet ?? bindLauncher(
      launcher,
      settings.rememberPosition ? settings.position : null,
      position => {
        if (!settings.rememberPosition || transfer.isApplying) return;
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
      if (transfer.isApplying && !button.classList.contains('close-button')) return;
      const destination = guideDestination(button.dataset.guideTarget);
      if (destination) {
        navigate(destination.page, true, destination.featureTab, destination);
        return;
      }
      const nextFeatureTab = button.dataset.featureTab;
      if ((nextFeatureTab === 'anchors' || nextFeatureTab === 'worldbook') && (!button.dataset.page || button.dataset.page === 'features')) {
        navigate('features', true, nextFeatureTab);
      } else if (isPageId(button.dataset.page)) navigate(button.dataset.page);
      if (button.dataset.section === 'config-transfer' && page === 'preferences') {
        revealSection('[data-config-transfer]');
      }
      if (button.classList.contains('close-button')) panel.close();
      if (button.dataset.action === 'reset-pet-scale') setPetScale(1);
      if (button.dataset.action === 'reset-preferences') {
        settings = defaultSettings();
        floating!.reset();
        persist();
        refreshTheme();
        navigate('preferences', false);
        content.querySelector<HTMLElement>('[data-feedback]')!.textContent = '已恢复默认偏好。';
        content.querySelector<HTMLButtonElement>('[data-action="reset-preferences"]')!.focus();
      }
    }, { signal });

    root.addEventListener('input', event => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.name === 'petScale') setPetScale(Number(input.value) / 100);
    }, { signal });

    root.addEventListener('change', event => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.name === 'petScale') {
        setPetScale(Number(input.value) / 100);
        return;
      }
      if (input instanceof HTMLInputElement && input.name === 'syncApiKeys') {
        if (transfer.isApplying || changingSyncKeys || !getHostStore()) { input.checked = getSyncApiKeys(); return; }
        const enabled = input.checked;
        changingSyncKeys = true;
        input.disabled = true;
        const status = content.querySelector<HTMLElement>('[data-host-sync-status]');
        if (status) { status.textContent = '正在保存同步设置…'; status.classList.remove('is-error'); }
        void setSyncApiKeys(enabled).then(() => {
          if (status) status.textContent = enabled ? '已开启：API 密钥会随 TT 扩展数据同步。' : '已关闭：API 密钥仅保留在本机。';
        }).catch(error => {
          if (status) { status.textContent = error instanceof Error ? error.message : '同步设置未能保存，请重试。'; status.classList.add('is-error'); }
        }).finally(() => {
          changingSyncKeys = false;
          input.checked = getSyncApiKeys();
          input.disabled = false;
        });
        return;
      }
      if (input instanceof HTMLSelectElement && input.name === 'paintboxTheme') {
        if (transfer.isApplying || !isPaintboxTheme(input.value)) { input.value = settings.paintboxTheme; return; }
        settings.paintboxTheme = input.value;
        persist();
        refreshTheme();
        return;
      }
      if (input instanceof HTMLSelectElement && input.name === 'imageRetentionDays') {
        if (transfer.isApplying) { input.value = String(settings.imageRetentionDays); return; }
        const days = Number(input.value);
        if (![0, 1, 3, 7].includes(days)) return;
        settings.imageRetentionDays = days as typeof settings.imageRetentionDays;
        persist();
        return;
      }
      if (!(input instanceof HTMLInputElement) || !['rememberPage', 'rememberPosition', 'autoGenerateImages', 'petLines', 'petMotion'].includes(input.name)) return;
      if (transfer.isApplying) { input.checked = settings[input.name as 'rememberPage' | 'rememberPosition' | 'autoGenerateImages' | 'petLines' | 'petMotion']; return; }
      if (input.name === 'rememberPage') {
        settings.rememberPage = input.checked;
        settings.lastPage = page;
      }
      if (input.name === 'rememberPosition') {
        settings.rememberPosition = input.checked;
        settings.position = input.checked ? floating!.getPosition() : null;
        settings.petPlacement = null;
      }
      if (input.name === 'autoGenerateImages') settings.autoGenerateImages = input.checked;
      if (input.name === 'petLines') settings.petLines = input.checked;
      if (input.name === 'petMotion') settings.petMotion = input.checked;
      persist();
      content.querySelector<HTMLElement>('[data-feedback]')!.textContent = '更改会自动保存。';
    }, { signal });
  }, { once: true, signal });

  panel.addEventListener('close', () => {
    imageReview.unmount();
    imageConfig.maskKey();
    modelConfig.maskKey();
    launcher.setAttribute('aria-expanded', 'false');
    if (panelOpener.isConnected && panelOpener.getClientRects().length) panelOpener.focus({ preventScroll: true });
    emitPetEvent({ type: 'ui', action: 'panel-close' });
  }, { signal });
  stylesheet.addEventListener('error', () => {
    console.error(`[${pluginName}] 样式加载失败，请检查扩展文件是否完整。`);
    emitPetEvent({ type: 'stop' });
    controller.abort();
    imageConfig.destroy();
    modelConfig.destroy();
    imageReview.unmount();
    anchorConfig.destroy();
    transfer.unmount();
    host.remove();
  }, { once: true, signal });
  window.addEventListener('pagehide', event => {
    imageConfig.maskKey();
    modelConfig.maskKey();
    if (event.persisted) return;
    emitPetEvent({ type: 'stop' });
    controller.abort();
    imageConfig.destroy();
    modelConfig.destroy();
    imageReview.unmount();
    anchorConfig.destroy();
    transfer.unmount();
    host.remove();
  }, { signal });

  host.hidden = true;
  document.body.append(host);
}

$(() => { void mount().catch(() => {
  const message = '魔女画匣未能读取或迁移配置，原有记录已保留。请检查 TT 扩展数据或浏览器存储后重新打开。';
  console.error(message);
  const toast = (window as Window & { toastr?: { error(message: string): void } }).toastr;
  if (toast) toast.error(message);
  else window.alert(message);
}); });
