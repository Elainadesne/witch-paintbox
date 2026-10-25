import { NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULES } from './novelai.js';
import { imageFileExtension } from './raster-image.js';
export function createImageGallery(summary, signal, handlers) {
    const element = document.createElement('dialog');
    element.className = 'wp-gallery';
    element.setAttribute('aria-label', `${summary} · 图片查看器`);
    element.innerHTML = `<style>
    .wp-gallery { position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 0; overflow: hidden; border: 0; border-radius: 0; background: #fdfaf2; color: #3c3931; font: 14px/1.5 system-ui, sans-serif; color-scheme: light; }
    .wp-gallery, .wp-gallery * { box-sizing: border-box; }
    .wp-gallery[open] { display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
    .wp-gallery:not([open]), .wp-gallery [hidden] { display: none; }
    .wp-gallery::backdrop { background: #fdfaf2; }
    .wp-gallery button, .wp-gallery a { color: inherit; font: inherit; }
    .wp-gallery button, .wp-gallery-action { min-height: 38px; padding: 8px 10px; border: 0; border-radius: 0; background: transparent; box-shadow: none; text-decoration: none; cursor: pointer; white-space: nowrap; }
    .wp-gallery button:hover:not(:disabled), .wp-gallery-action:hover:not([aria-disabled="true"]) { background: #89682f12; }
    .wp-gallery button:disabled, .wp-gallery [aria-disabled="true"] { opacity: .4; cursor: default; }
    .wp-gallery :focus-visible { outline: 2px solid #89682f; outline-offset: 2px; }
    .wp-gallery-header { display: grid; min-width: 0; min-height: 0; max-height: 32vh; max-height: 32dvh; gap: 6px; padding: 10px 20px 8px; overflow-y: auto; }
    .wp-gallery-caption { display: grid; gap: 3px; min-width: 0; text-align: center; }
    .wp-gallery-caption-label { color: #756b5b; font-size: 11px; letter-spacing: .16em; }
    .wp-gallery-title { min-width: 0; margin: 0; font-size: 16px; font-weight: 550; overflow-wrap: anywhere; }
    .wp-gallery-tools { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 2px; min-width: 0; color: #675b48; font-size: 13px; }
    .wp-gallery-status { margin: 0; color: #756b5b; font-size: 12px; overflow-wrap: anywhere; }
    .wp-gallery-status:empty { display: none; }
    .wp-gallery-status[data-error="true"] { color: #a3463e; }
    .wp-gallery-history { min-width: 0; padding: 0 20px 10px; }
    .wp-gallery-counter { margin: 0 0 7px; text-align: center; font-size: 13px; color: #756b5b; font-variant-numeric: tabular-nums; }
    .wp-gallery-thumbnails { display: flex; gap: 10px; max-width: 100%; padding: 3px 2px 7px; overflow-x: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .wp-gallery-thumbnails:empty { display: none; }
    .wp-gallery .wp-gallery-thumb { flex: 0 0 64px; width: 64px; height: 64px; min-height: 0; padding: 0 0 4px; border-bottom: 2px solid transparent; opacity: .55; }
    .wp-gallery .wp-gallery-thumb[aria-current="true"] { border-bottom-color: #89682f; opacity: 1; }
    .wp-gallery .wp-gallery-thumb:hover { opacity: 1; }
    .wp-gallery-thumb img { display: block; width: 100%; height: 100%; margin: 0; object-fit: cover; }
    .wp-gallery-workspace { display: grid; grid-template-rows: minmax(0, 1fr) 0px; min-width: 0; min-height: 0; overflow: hidden; transition: grid-template-rows .18s ease; }
    .wp-gallery-workspace[data-drawer="open"] { grid-template-rows: minmax(0, 1fr) min(44%, 340px); }
    .wp-gallery-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
    .wp-gallery-image-frame { position: absolute; inset: 12px 20px 20px; display: grid; place-items: center; min-width: 0; min-height: 0; }
    .wp-gallery-image { position: absolute; inset: 0; display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; max-width: none; max-height: none; margin: 0; object-fit: contain; }
    .wp-gallery-empty { margin: 0; color: #756b5b; }
    .wp-gallery-drawer { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; overflow: hidden; border-top: 1px solid #d8cfbd; background: #f6f0e2; transform: translateY(100%); visibility: hidden; transition: transform .18s ease, visibility .18s; }
    .wp-gallery-workspace[data-drawer="open"] .wp-gallery-drawer { transform: translateY(0); visibility: visible; }
    .wp-gallery-drawer-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 0 18px; }
    .wp-gallery-drawer-header h3 { margin: 0; color: #89682f; font-size: 13px; font-weight: 500; }
    .wp-gallery-drawer-body { min-height: 0; padding: 8px 20px 20px; overflow-y: auto; overscroll-behavior: contain; }
    .wp-gallery-properties { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px 22px; margin: 0; }
    .wp-gallery-properties div { min-width: 0; }
    .wp-gallery-properties dt { margin-bottom: 3px; color: #756b5b; font-size: 11px; }
    .wp-gallery-properties dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
    .wp-gallery-prompt { margin-top: 18px; }
    .wp-gallery-prompt h4 { margin: 0 0 6px; font-size: 12px; font-weight: 500; color: #756b5b; }
    .wp-gallery-prompt pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 system-ui, sans-serif; color: inherit; background: transparent; border: 0; padding: 0; }
    @media (max-width: 640px) {
      .wp-gallery-header { gap: 4px; padding: 6px 12px; }
      .wp-gallery-title { font-size: 14px; }
      .wp-gallery-tools { gap: 0; font-size: 12px; }
      .wp-gallery button, .wp-gallery-action { min-height: 36px; padding: 7px 8px; }
      .wp-gallery-history { padding: 0 12px 6px; }
      .wp-gallery .wp-gallery-thumb { flex-basis: 52px; width: 52px; height: 52px; }
      .wp-gallery-image-frame { inset: 8px 12px 12px; }
      .wp-gallery-properties { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
      .wp-gallery-drawer-header { padding: 0 12px; }
      .wp-gallery-drawer-body { padding: 6px 12px 16px; }
    }
    @media (max-height: 500px) {
      .wp-gallery-header { gap: 2px; padding-top: 2px; padding-bottom: 4px; }
      .wp-gallery-title { font-size: 13px; }
      .wp-gallery button, .wp-gallery-action { min-height: 30px; padding-top: 4px; padding-bottom: 4px; }
      .wp-gallery-history { padding-bottom: 2px; }
      .wp-gallery-counter { margin-bottom: 2px; }
      .wp-gallery-thumbnails { padding-top: 0; padding-bottom: 3px; }
      .wp-gallery .wp-gallery-thumb { flex-basis: 36px; width: 36px; height: 36px; }
      .wp-gallery-image-frame { inset: 4px 12px 8px; }
    }
    @media (prefers-reduced-motion: reduce) { .wp-gallery-workspace, .wp-gallery-drawer { transition: none; } }
  </style>
  <header class="wp-gallery-header">
    <nav class="wp-gallery-tools" aria-label="当前图片操作">
      <a class="wp-gallery-action" data-gallery-download aria-label="下载当前图片" aria-disabled="true" tabindex="-1">下载</a>
      <button type="button" data-gallery-delete aria-label="删除当前图片" disabled>删除</button>
      <button type="button" data-gallery-properties aria-label="查看生成属性" aria-expanded="false" disabled>生成属性</button>
      <button type="button" data-gallery-close aria-label="关闭图片查看器">关闭</button>
    </nav>
    <div class="wp-gallery-caption"><span class="wp-gallery-caption-label">画题</span><h2 class="wp-gallery-title"></h2></div>
    <p class="wp-gallery-status" role="status"></p>
  </header>
  <section class="wp-gallery-history" aria-label="同一标记的图片历史">
    <p class="wp-gallery-counter" aria-live="polite">0 / 0</p>
    <div class="wp-gallery-thumbnails" role="group" aria-label="选择历史图片"></div>
  </section>
  <div class="wp-gallery-workspace" data-drawer="closed">
    <main class="wp-gallery-stage"><div class="wp-gallery-image-frame"><img class="wp-gallery-image" decoding="async" hidden><p class="wp-gallery-empty">暂无图片</p></div></main>
    <section class="wp-gallery-drawer" aria-label="生成属性" aria-hidden="true" inert>
      <header class="wp-gallery-drawer-header"><h3>生成属性</h3><button type="button" data-gallery-drawer-close aria-label="收起生成属性">收起</button></header>
      <div class="wp-gallery-drawer-body">
        <dl class="wp-gallery-properties"></dl>
        <div data-gallery-prompts></div>
      </div>
    </section>
  </div>`;
    const title = element.querySelector('.wp-gallery-title');
    const download = element.querySelector('[data-gallery-download]');
    const deleteButton = element.querySelector('[data-gallery-delete]');
    const propertiesButton = element.querySelector('[data-gallery-properties]');
    const closeButton = element.querySelector('[data-gallery-close]');
    const status = element.querySelector('.wp-gallery-status');
    const counter = element.querySelector('.wp-gallery-counter');
    const thumbnails = element.querySelector('.wp-gallery-thumbnails');
    const image = element.querySelector('.wp-gallery-image');
    const empty = element.querySelector('.wp-gallery-empty');
    const workspace = element.querySelector('.wp-gallery-workspace');
    const drawer = element.querySelector('.wp-gallery-drawer');
    const drawerClose = element.querySelector('[data-gallery-drawer-close]');
    const properties = element.querySelector('.wp-gallery-properties');
    const prompts = element.querySelector('[data-gallery-prompts]');
    const thumbnailButtons = new Map();
    let items = [];
    let selectedId = null;
    let deletingId = null;
    let drawerOpen = false;
    title.textContent = summary;
    function message(text = '', error = false) {
        status.textContent = text;
        status.dataset.error = String(error);
    }
    function setDrawer(open, restoreFocus = false) {
        drawerOpen = open && items.some(item => item.entry.id === selectedId);
        workspace.dataset.drawer = drawerOpen ? 'open' : 'closed';
        drawer.inert = !drawerOpen;
        drawer.setAttribute('aria-hidden', String(!drawerOpen));
        propertiesButton.setAttribute('aria-expanded', String(drawerOpen));
        if (element.open && restoreFocus)
            (drawerOpen ? drawerClose : propertiesButton).focus({ preventScroll: true });
    }
    function renderSelected() {
        const index = items.findIndex(item => item.entry.id === selectedId);
        const current = items[index];
        counter.textContent = `${current ? index + 1 : 0} / ${items.length}`;
        deleteButton.disabled = !current || deletingId !== null;
        deleteButton.textContent = deletingId ? '删除中…' : '删除';
        propertiesButton.disabled = !current;
        image.hidden = !current;
        empty.hidden = Boolean(current);
        for (const [id, button] of thumbnailButtons)
            button.setAttribute('aria-current', String(id === selectedId));
        if (!current) {
            image.removeAttribute('src');
            download.removeAttribute('href');
            download.removeAttribute('download');
            download.setAttribute('aria-disabled', 'true');
            download.tabIndex = -1;
            properties.replaceChildren();
            prompts.replaceChildren();
            setDrawer(false);
            if (element.open)
                closeButton.focus({ preventScroll: true });
            return;
        }
        const { entry, url } = current;
        if (image.getAttribute('src') !== url)
            image.src = url;
        image.alt = `${summary} · 第 ${index + 1} 张`;
        image.width = entry.parameters.width;
        image.height = entry.parameters.height;
        download.href = url;
        download.download = `witch-paintbox-${entry.seed ?? entry.id}.${imageFileExtension(entry.blob)}`;
        download.removeAttribute('aria-disabled');
        download.removeAttribute('tabindex');
        const fields = [
            ['生图服务', entry.provider === 'openai' ? 'GPT / OpenAI 兼容接口' : 'NovelAI'],
            ['模型', entry.provider === 'openai' ? entry.parameters.model
                    : NAI_MODELS.find(model => model.value === entry.parameters.model)?.label ?? entry.parameters.model],
            ['尺寸', `${entry.parameters.width} × ${entry.parameters.height}`],
            ['生成时间', new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })],
        ];
        if (entry.provider === 'openai') {
            fields.push(['请求质量', entry.parameters.quality], ['输出格式', imageFileExtension(entry.blob).toUpperCase()]);
        }
        else {
            const params = entry.parameters;
            fields.push(['步数', params.steps], ['CFG', params.scale], ['采样器', NAI_SAMPLERS.find(sampler => sampler.value === params.sampler)?.label ?? params.sampler], ['噪声调度', params.model.startsWith('nai-diffusion-5') ? 'Karras' : params.sampler === 'k_dpm_fast' ? '不适用' : NAI_SCHEDULES.find(schedule => schedule.value === params.noiseSchedule)?.label ?? params.noiseSchedule], ['实际种子', entry.seed], ['引导重缩放', params.cfgRescale], ['SMEA', params.sm ? '开启' : '关闭'], ['SMEA DYN', params.smDyn ? '开启' : '关闭']);
        }
        properties.replaceChildren(...fields.map(([label, value]) => {
            const field = document.createElement('div');
            const name = document.createElement('dt');
            const detail = document.createElement('dd');
            name.textContent = String(label);
            detail.textContent = String(value);
            field.append(name, detail);
            return field;
        }));
        const characterPrompts = entry.characters ?? [];
        const promptFields = [[characterPrompts.length ? '全局正面提示词' : '正面提示词', entry.positive]];
        if (entry.provider !== 'openai')
            promptFields.push([characterPrompts.length ? '全局负面提示词' : '负面提示词', entry.negative]);
        characterPrompts.forEach((character, index) => {
            promptFields.push([`角色 ${index + 1} · 正面提示词`, character.positive]);
            promptFields.push([`角色 ${index + 1} · 负面提示词`, character.negative]);
        });
        prompts.replaceChildren(...promptFields.map(([label, value]) => {
            const section = document.createElement('section');
            section.className = 'wp-gallery-prompt';
            const heading = document.createElement('h4');
            const content = document.createElement('pre');
            heading.textContent = label;
            content.textContent = value || '（空）';
            section.append(heading, content);
            return section;
        }));
    }
    function revealSelected() {
        if (selectedId && element.open)
            thumbnailButtons.get(selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function select(id) {
        if (id === selectedId || !items.some(item => item.entry.id === id))
            return;
        selectedId = id;
        if (!deletingId)
            message();
        renderSelected();
        revealSelected();
        handlers.onSelect(id);
    }
    function setImages(nextItems, nextSelectedId) {
        const scrollLeft = thumbnails.scrollLeft;
        const focusedId = thumbnails.querySelector(':focus')?.dataset.imageId;
        const previousId = selectedId;
        items = [...nextItems];
        selectedId = items.some(item => item.entry.id === nextSelectedId) ? nextSelectedId
            : items.some(item => item.entry.id === selectedId) ? selectedId : items.at(-1)?.entry.id ?? null;
        const liveIds = new Set(items.map(item => item.entry.id));
        for (const id of thumbnailButtons.keys())
            if (!liveIds.has(id))
                thumbnailButtons.delete(id);
        thumbnails.replaceChildren(...items.map(({ entry, url }, index) => {
            let button = thumbnailButtons.get(entry.id);
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'wp-gallery-thumb';
                button.dataset.imageId = entry.id;
                const thumbnail = document.createElement('img');
                thumbnail.loading = 'lazy';
                thumbnail.decoding = 'async';
                thumbnail.alt = '';
                button.append(thumbnail);
                thumbnailButtons.set(entry.id, button);
            }
            button.setAttribute('aria-label', `查看第 ${index + 1} 张图片`);
            const thumbnail = button.firstElementChild;
            if (thumbnail.getAttribute('src') !== url)
                thumbnail.src = url;
            return button;
        }));
        renderSelected();
        if (focusedId && element.open)
            (thumbnailButtons.get(focusedId) ?? thumbnailButtons.get(selectedId ?? '') ?? closeButton).focus({ preventScroll: true });
        thumbnails.scrollLeft = scrollLeft;
        if (previousId !== selectedId)
            revealSelected();
    }
    function close() {
        setDrawer(false);
        if (element.open)
            element.close();
    }
    thumbnails.addEventListener('click', event => {
        const button = event.target.closest('[data-image-id]');
        if (button?.dataset.imageId)
            select(button.dataset.imageId);
    }, { signal });
    propertiesButton.addEventListener('click', () => setDrawer(!drawerOpen, true), { signal });
    drawerClose.addEventListener('click', () => setDrawer(false, true), { signal });
    closeButton.addEventListener('click', close, { signal });
    download.addEventListener('click', event => {
        event.stopPropagation();
        if (!download.hasAttribute('href'))
            event.preventDefault();
    }, { signal });
    deleteButton.addEventListener('click', async () => {
        if (!selectedId || deletingId)
            return;
        deletingId = selectedId;
        renderSelected();
        message('正在删除当前图片…');
        try {
            await handlers.onDelete(deletingId);
            if (!signal.aborted)
                message();
        }
        catch (error) {
            if (!signal.aborted)
                message(error instanceof Error ? error.message : '删除图片失败，请重试。', true);
        }
        finally {
            deletingId = null;
            if (!signal.aborted)
                renderSelected();
        }
    }, { signal });
    element.addEventListener('cancel', event => {
        event.preventDefault();
        if (drawerOpen)
            setDrawer(false, true);
        else
            close();
    }, { signal });
    element.addEventListener('close', () => setDrawer(false), { signal });
    element.addEventListener('click', event => event.stopPropagation(), { signal });
    element.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key))
            return;
        const index = items.findIndex(item => item.entry.id === selectedId);
        const next = items[index + (event.key === 'ArrowRight' ? 1 : -1)];
        event.preventDefault();
        if (next)
            select(next.entry.id);
    }, { signal });
    element.addEventListener('keyup', event => event.stopPropagation(), { signal });
    let portal = null;
    const removePortal = () => { portal?.remove(); portal = null; };
    signal.addEventListener('abort', () => { close(); removePortal(); }, { once: true });
    return {
        element, setImages, close,
        open() {
            if (signal.aborted)
                return;
            if (element.ownerDocument !== document) {
                if (!portal || !portal.isConnected) {
                    removePortal();
                    portal = document.createElement('div');
                    portal.className = 'witch-paintbox-gallery-portal';
                    const shadow = portal.attachShadow({ mode: 'open' });
                    document.body.append(portal);
                    shadow.append(document.adoptNode(element));
                }
            }
            if (!element.isConnected)
                return;
            if (element.open && element.matches(':modal'))
                return;
            if (element.open)
                element.close();
            element.showModal();
            (thumbnailButtons.get(selectedId ?? '') ?? closeButton).focus({ preventScroll: true });
            revealSelected();
        },
    };
}
