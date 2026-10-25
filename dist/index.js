import { bindLauncher } from './launcher.js';
import { bindLauncherMenu } from './launcher-menu.js';
import { bindChatImages } from './chat-images.js';
import { ImageConfig } from './image-config.js';
import { ModelConfig } from './model-config.js';
import { AnchorConfig } from './anchor-config.js';
import { ConfigTransfer } from './config-transfer.js';
import { registerBuiltinLayers } from './builtin-layers.js';
import { bindContextFilter } from './context-filter.js';
import { isPageId, pluginName } from './pages.js';
import { defaultSettings, extensionId, readSettings, saveSettings } from './settings.js';
import { navigationView, pageView } from './views.js';
import { getHostStore, initializeHostStorage } from './host-storage.js';
import { getSyncApiKeys, initializeSettingsStorage, setSyncApiKeys } from './host-settings.js';
import { initializeNativeLibraries } from './host-library.js';
import { bindUpdateNotice, updateNoticeView } from './extension-updates.js';
import { ImageReview } from './image-review.js';
import { bindImageRetention, imageRetentionStatus } from './image-retention.js';
import { bindImageHistorySync } from './image-history.js';
async function mount() {
    if (document.getElementById(extensionId))
        return;
    await initializeHostStorage();
    await Promise.all([initializeSettingsStorage(), initializeNativeLibraries()]);
    const unregisterLayers = registerBuiltinLayers();
    const context = SillyTavern.getContext();
    let settings = readSettings(context);
    let page = 'guide';
    let connectionPage = 'image-api';
    let featureTab = 'anchors';
    const imageConfig = new ImageConfig();
    const modelConfig = new ModelConfig();
    const imageReview = new ImageReview();
    let anchorConfig = new AnchorConfig();
    let floating = null;
    let changingSyncKeys = false;
    const transfer = new ConfigTransfer(context, (kind, provider) => {
        if (kind === 'all' || kind === 'artists')
            imageConfig.reloadSaved(kind === 'artists');
        if (kind === 'presets')
            modelConfig.reloadSaved(kind, provider);
        if (kind === 'worldbooks') {
            modelConfig.reloadSaved('worldbooks', 'novelai');
            modelConfig.reloadSaved('worldbooks', 'openai');
        }
        if (kind === 'all') {
            modelConfig.reloadSaved();
            anchorConfig.destroy();
            anchorConfig = new AnchorConfig();
            settings = readSettings(context);
            if (settings.rememberPosition && settings.position)
                floating?.setPosition(settings.position);
            else
                floating?.reset();
            for (const input of Array.from(content.querySelectorAll('.preference-row input'))) {
                if (input.name === 'rememberPage' || input.name === 'rememberPosition' || input.name === 'autoGenerateImages')
                    input.checked = settings[input.name];
            }
            const retention = content.querySelector('[name="imageRetentionDays"]');
            if (retention)
                retention.value = String(settings.imageRetentionDays);
        }
    }, () => imageConfig.hasPendingWrites || modelConfig.hasPendingWrites || anchorConfig.hasPendingWrites || changingSyncKeys ? '配置仍在保存或角色图仍在生成，请完成后再导入或导出。' : undefined);
    const controller = new AbortController();
    const { signal } = controller;
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
    const launcher = root.querySelector('.launcher');
    const panel = root.querySelector('.panel');
    const sidebar = root.querySelector('.sidebar');
    const content = root.querySelector('.content');
    const apiSwitch = root.querySelector('.api-switch');
    const updateNotice = bindUpdateNotice(root, signal);
    const persist = () => saveSettings(context, settings);
    const showCleanupStatus = () => {
        const status = content.querySelector('[data-cleanup-status]');
        if (status)
            status.textContent = imageRetentionStatus();
    };
    window.addEventListener('witch-paintbox:cleanup-status', showCleanupStatus, { signal });
    const launcherMenu = bindLauncherMenu(launcher, root, signal, () => openPanel(settings.rememberPage ? settings.lastPage : 'guide'));
    function openPanel(target) {
        if (panel.open)
            return;
        launcherMenu.close();
        navigate(target, false);
        panel.showModal();
        updateNotice.check();
        content.focus({ preventScroll: true });
    }
    function navigate(next, focus = true, nextFeatureTab) {
        if (transfer.isApplying || changingSyncKeys)
            return;
        imageConfig.unmount();
        modelConfig.unmount();
        imageReview.unmount();
        anchorConfig.unmount();
        transfer.unmount();
        page = next;
        if (page === 'features' && nextFeatureTab)
            featureTab = nextFeatureTab;
        const isConnection = page === 'image-api' || page === 'model-api';
        if (isConnection)
            connectionPage = page;
        sidebar.innerHTML = navigationView(page);
        sidebar.querySelector('[data-page="image-api"]').dataset.page = connectionPage;
        apiSwitch.hidden = !isConnection;
        apiSwitch.querySelectorAll('button').forEach(button => {
            if (button.dataset.page === page)
                button.setAttribute('aria-current', 'page');
            else
                button.removeAttribute('aria-current');
        });
        content.innerHTML = pageView(page, settings, featureTab);
        const imageContainer = content.querySelector('[data-image-settings]');
        const anchorContainer = content.querySelector('[data-anchor-settings]');
        const modelContainer = content.querySelector('[data-model-settings]');
        if (page === 'image-api' && imageContainer)
            imageConfig.mount(imageContainer);
        if (page === 'features' && anchorContainer)
            anchorConfig.mount(anchorContainer);
        if (page === 'model-api' || page === 'features') {
            if (modelContainer)
                modelConfig.mount(modelContainer, page === 'model-api' ? 'model' : featureTab === 'worldbook' ? 'worldbook' : 'features');
        }
        const transferContainer = content.querySelector('[data-config-transfer]');
        if (page === 'preferences' && transferContainer)
            transfer.mount(transferContainer);
        const reviewContainer = content.querySelector('[data-image-review]');
        if (page === 'review' && reviewContainer)
            imageReview.mount(reviewContainer);
        showCleanupStatus();
        content.scrollTop = 0;
        settings.lastPage = page;
        persist();
        if (focus)
            content.focus({ preventScroll: true });
    }
    // Wait for the isolated styles before measuring the floating button.
    stylesheet.addEventListener('load', () => {
        host.hidden = false;
        bindChatImages(signal);
        floating = bindLauncher(launcher, settings.rememberPosition ? settings.position : null, position => {
            if (!settings.rememberPosition || transfer.isApplying)
                return;
            settings.position = position;
            persist();
        }, launcherMenu.toggle, signal, launcherMenu.close);
        root.addEventListener('click', event => {
            const target = event.target;
            if (!(target instanceof Element))
                return;
            const button = target.closest('button');
            if (!button)
                return;
            if (transfer.isApplying && !button.classList.contains('close-button'))
                return;
            const nextFeatureTab = button.dataset.featureTab;
            if ((nextFeatureTab === 'anchors' || nextFeatureTab === 'worldbook') && (!button.dataset.page || button.dataset.page === 'features')) {
                navigate('features', true, nextFeatureTab);
            }
            else if (isPageId(button.dataset.page))
                navigate(button.dataset.page);
            if (button.dataset.section === 'config-transfer' && page === 'preferences') {
                const target = content.querySelector('[data-config-transfer]');
                if (target) {
                    target.tabIndex = -1;
                    target.scrollIntoView({ block: 'start' });
                    target.focus({ preventScroll: true });
                }
            }
            if (button.classList.contains('close-button'))
                panel.close();
            if (button.dataset.action === 'reset-preferences') {
                settings = defaultSettings();
                floating.reset();
                persist();
                navigate('preferences', false);
                content.querySelector('[data-feedback]').textContent = '已恢复默认偏好。';
                content.querySelector('[data-action="reset-preferences"]').focus();
            }
        }, { signal });
        root.addEventListener('change', event => {
            const input = event.target;
            if (input instanceof HTMLInputElement && input.name === 'syncApiKeys') {
                if (transfer.isApplying || changingSyncKeys || !getHostStore()) {
                    input.checked = getSyncApiKeys();
                    return;
                }
                const enabled = input.checked;
                changingSyncKeys = true;
                input.disabled = true;
                const status = content.querySelector('[data-host-sync-status]');
                if (status) {
                    status.textContent = '正在保存同步设置…';
                    status.classList.remove('is-error');
                }
                void setSyncApiKeys(enabled).then(() => {
                    if (status)
                        status.textContent = enabled ? '已开启：API 密钥会随 TT 扩展数据同步。' : '已关闭：API 密钥仅保留在本机。';
                }).catch(error => {
                    if (status) {
                        status.textContent = error instanceof Error ? error.message : '同步设置未能保存，请重试。';
                        status.classList.add('is-error');
                    }
                }).finally(() => {
                    changingSyncKeys = false;
                    input.checked = getSyncApiKeys();
                    input.disabled = false;
                });
                return;
            }
            if (input instanceof HTMLSelectElement && input.name === 'imageRetentionDays') {
                if (transfer.isApplying) {
                    input.value = String(settings.imageRetentionDays);
                    return;
                }
                const days = Number(input.value);
                if (![0, 1, 3, 7].includes(days))
                    return;
                settings.imageRetentionDays = days;
                persist();
                return;
            }
            if (!(input instanceof HTMLInputElement) || !['rememberPage', 'rememberPosition', 'autoGenerateImages'].includes(input.name))
                return;
            if (transfer.isApplying) {
                input.checked = settings[input.name];
                return;
            }
            if (input.name === 'rememberPage') {
                settings.rememberPage = input.checked;
                settings.lastPage = page;
            }
            if (input.name === 'rememberPosition') {
                settings.rememberPosition = input.checked;
                settings.position = input.checked ? floating.getPosition() : null;
            }
            if (input.name === 'autoGenerateImages')
                settings.autoGenerateImages = input.checked;
            persist();
            content.querySelector('[data-feedback]').textContent = '更改会自动保存。';
        }, { signal });
    }, { once: true, signal });
    panel.addEventListener('close', () => {
        imageReview.unmount();
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
        imageReview.unmount();
        anchorConfig.destroy();
        transfer.unmount();
        host.remove();
    }, { once: true, signal });
    window.addEventListener('pagehide', event => {
        imageConfig.maskKey();
        modelConfig.maskKey();
        if (event.persisted)
            return;
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
$(() => {
    void mount().catch(() => {
        const message = '魔女画匣未能读取或迁移配置，原有记录已保留。请检查 TT 扩展数据或浏览器存储后重新打开。';
        console.error(message);
        const toast = window.toastr;
        if (toast)
            toast.error(message);
        else
            window.alert(message);
    });
});
