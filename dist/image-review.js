import { imageChatContext, watchChatRendering } from './chat-host.js';
import { loadImageHistoryPage, loadImageHistoryCategories, deleteImageHistory, historyScope, historySourceName, historyTitle, historyWasDeleted, onImageHistoryChanged } from './image-history.js';
import { createImageGallery } from './image-gallery.js';
/** A bounded page of local images. Switching pages releases every old object URL. */
export class ImageReview {
    container = null;
    controller = null;
    stopHistory = () => { };
    stopChat = () => { };
    items = [];
    all = false;
    scope = null;
    categories = [];
    category = null;
    cursors = [null];
    next = null;
    more = false;
    loading = false;
    version = 0;
    gallery = null;
    galleryController = null;
    selectedId = null;
    mount(container, initialScope) {
        this.unmount();
        if (initialScope) {
            this.all = initialScope === 'all';
            this.category = null;
        }
        this.container = container;
        this.controller = new AbortController();
        const { signal } = this.controller;
        this.scope = imageChatContext()?.scope ?? null;
        this.cursors = [null];
        container.innerHTML = `<section class="image-review">
      <div class="review-toolbar"><nav class="anchor-tabs" aria-label="图片范围"><button type="button" data-review-scope="current">当前角色卡</button><button type="button" data-review-scope="all">全部角色卡</button></nav><button type="button" class="text-button" data-review-action="refresh">刷新</button></div>
      <nav class="review-categories" data-review-categories aria-label="按角色卡筛选" hidden></nav>
      <p class="config-status" data-review-context></p><p class="config-status" data-review-status role="status">正在读取图片…</p>
      <div class="review-grid" data-review-grid></div>
      <nav class="review-pagination" aria-label="图片翻页"><button type="button" class="secondary" data-review-action="previous">上一页</button><span data-review-page></span><button type="button" class="secondary" data-review-action="next">下一页</button></nav>
    </section>`;
        container.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button)
                return;
            if (button.dataset.reviewScope) {
                this.all = button.dataset.reviewScope === 'all';
                this.cursors = [null];
                void this.load(true);
                return;
            }
            if (button.dataset.reviewCategory !== undefined) {
                this.category = button.dataset.reviewCategory || null;
                this.cursors = [null];
                void this.load();
                return;
            }
            if (button.dataset.reviewImage)
                this.open(button.dataset.reviewImage);
            if (this.loading)
                return;
            if (button.dataset.reviewAction === 'refresh') {
                this.cursors = [null];
                void this.load(true);
            }
            if (button.dataset.reviewAction === 'previous' && this.cursors.length > 1) {
                this.cursors.pop();
                void this.load();
            }
            if (button.dataset.reviewAction === 'next' && this.more && this.next) {
                this.cursors.push(this.next);
                void this.load();
            }
        }, { signal });
        this.stopHistory = onImageHistoryChanged(change => {
            if (change.savedId) {
                if (!this.gallery?.element.open && this.cursors.length === 1)
                    void this.load(true);
                else
                    this.message('有新图片，点击“刷新”查看。');
                return;
            }
            // Invalidate an earlier read so a deletion cannot resurrect its page of blobs.
            this.version++;
            this.loading = false;
            const removed = this.items.filter(item => historyWasDeleted(item.entry, change));
            this.items = this.items.filter(item => !historyWasDeleted(item.entry, change));
            const selected = this.items.find(item => item.entry.id === this.selectedId) ?? this.items.at(-1);
            this.selectedId = selected?.entry.id ?? null;
            this.gallery?.setSummary(selected ? historyTitle(selected.entry) : '生图回顾');
            this.gallery?.setImages(this.items, this.selectedId);
            this.render();
            removed.forEach(item => URL.revokeObjectURL(item.url));
            if (!this.gallery?.element.open)
                void this.load(true);
        });
        this.stopChat = watchChatRendering(() => {
            const scope = imageChatContext()?.scope ?? null;
            if (scope === this.scope)
                return;
            this.scope = scope;
            if (!this.all) {
                this.cursors = [null];
                void this.load();
            }
        });
        void this.load(true);
    }
    unmount() {
        this.version++;
        this.stopHistory();
        this.stopChat();
        this.controller?.abort();
        this.controller = null;
        this.release();
        this.container = null;
        this.loading = false;
    }
    release() {
        this.galleryController?.abort();
        this.galleryController = null;
        this.gallery?.element.remove();
        this.gallery = null;
        this.selectedId = null;
        this.items.forEach(item => URL.revokeObjectURL(item.url));
        this.items = [];
    }
    message(text, error = false) {
        const status = this.container?.querySelector('[data-review-status]');
        if (status) {
            status.textContent = text;
            status.classList.toggle('is-error', error);
        }
    }
    async load(refreshCategories = false) {
        if (!this.container)
            return;
        const version = ++this.version;
        this.loading = true;
        this.release();
        this.more = false;
        this.next = null;
        this.render();
        if (!this.all && !this.scope) {
            this.loading = false;
            this.message('请先打开角色卡聊天，或切换“全部角色卡”。');
            this.render();
            return;
        }
        this.message('正在读取图片…');
        try {
            if (this.all && refreshCategories) {
                const categories = await loadImageHistoryCategories();
                if (version !== this.version || !this.container)
                    return;
                this.categories = categories;
                if (this.category && !categories.some(item => item.scope === this.category)) {
                    this.category = null;
                    this.cursors = [null];
                }
            }
            const result = await loadImageHistoryPage(this.all ? this.category : this.scope, this.cursors.at(-1) ?? null);
            if (version !== this.version || !this.container)
                return;
            this.items = result.entries.map(entry => ({ entry, url: URL.createObjectURL(entry.blob) }));
            this.next = result.next;
            this.more = result.more;
            this.message(this.items.length ? '点击图片可全屏查看、下载、删除或查看生成属性。' : '这里还没有保存的图片。');
        }
        catch (error) {
            if (version === this.version)
                this.message(error instanceof Error ? error.message : '图片读取失败，请刷新重试。', true);
        }
        finally {
            if (version === this.version) {
                this.loading = false;
                this.render();
            }
        }
    }
    render() {
        const container = this.container;
        if (!container)
            return;
        container.querySelectorAll('[data-review-scope]').forEach(button => {
            button.setAttribute('aria-pressed', String((button.dataset.reviewScope === 'all') === this.all));
        });
        const context = imageChatContext();
        const categoryName = this.categories.find(item => item.scope === this.category)?.name;
        container.querySelector('[data-review-context]').textContent = `${this.all ? categoryName ?? '全部角色卡与未归属图片' : context?.name ?? '当前角色卡'} · 本机保存 · 每页最多 12 张`;
        this.renderCategories();
        const grid = container.querySelector('[data-review-grid]');
        grid.replaceChildren();
        for (const { entry, url } of this.items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'review-card';
            button.dataset.reviewImage = entry.id;
            const image = document.createElement('img');
            image.src = url;
            image.alt = historyTitle(entry);
            image.loading = 'lazy';
            image.decoding = 'async';
            const title = document.createElement('strong');
            title.textContent = historyTitle(entry);
            const source = document.createElement('span');
            source.className = 'muted';
            const label = historySourceName(historyScope(entry.markerKey), entry.sourceName);
            source.textContent = `${label} · ${new Date(entry.createdAt).toLocaleString()} · ${(entry.blob.size / 1024 / 1024).toFixed(1)} MB`;
            button.append(image, title, source);
            grid.append(button);
        }
        container.querySelector('[data-review-page]').textContent = `第 ${this.cursors.length} 页 · ${this.items.length} 张`;
        container.querySelector('[data-review-action="previous"]').disabled = this.loading || this.cursors.length <= 1;
        container.querySelector('[data-review-action="next"]').disabled = this.loading || !this.more;
        container.querySelector('[data-review-action="refresh"]').disabled = this.loading;
    }
    renderCategories() {
        const nav = this.container.querySelector('[data-review-categories]');
        const active = nav.getRootNode().activeElement;
        const focused = active instanceof HTMLButtonElement && nav.contains(active) ? active.dataset.reviewCategory : undefined;
        nav.hidden = !this.all;
        nav.replaceChildren();
        if (!this.all)
            return;
        const counts = new Map();
        const numbers = new Map();
        for (const item of this.categories)
            counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
        for (const item of [{ scope: '', name: '全部' }, ...this.categories]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.reviewCategory = item.scope;
            const number = (numbers.get(item.name) ?? 0) + 1;
            if (item.scope)
                numbers.set(item.name, number);
            button.textContent = item.scope && counts.get(item.name) > 1 ? `${item.name}（${number}）` : item.name;
            button.title = item.scope ? `查看${button.textContent}的图片` : '查看全部角色卡的图片';
            button.setAttribute('aria-pressed', String((this.category ?? '') === item.scope));
            nav.append(button);
            if (focused === item.scope)
                button.focus({ preventScroll: true });
        }
    }
    open(id) {
        const selected = this.items.find(item => item.entry.id === id);
        if (!selected || !this.container)
            return;
        this.galleryController?.abort();
        this.gallery?.element.remove();
        this.galleryController = new AbortController();
        this.selectedId = id;
        const gallery = createImageGallery(historyTitle(selected.entry), this.galleryController.signal, {
            onSelect: next => {
                this.selectedId = next;
                const item = this.items.find(item => item.entry.id === next);
                if (item) {
                    gallery.setSummary(historyTitle(item.entry));
                    gallery.setImages(this.items, next);
                }
            },
            onDelete: async (next) => { await deleteImageHistory(next); },
        });
        this.gallery = gallery;
        this.container.append(gallery.element);
        gallery.setImages(this.items, id);
        gallery.open();
    }
}
