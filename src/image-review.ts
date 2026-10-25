import { imageChatContext, watchChatRendering } from './chat-host.js';
import { loadImageHistoryPage, deleteImageHistory, historyScope, historyTitle, historyWasDeleted, onImageHistoryChanged } from './image-history.js';
import { createImageGallery, type GalleryImage } from './image-gallery.js';

/** A bounded page of local images. Switching pages releases every old object URL. */
export class ImageReview {
  private container: HTMLElement | null = null;
  private controller: AbortController | null = null;
  private stopHistory = () => {};
  private stopChat = () => {};
  private items: GalleryImage[] = [];
  private all = false;
  private scope: string | null = null;
  private cursors: Array<[number, string] | null> = [null];
  private next: [number, string] | null = null;
  private more = false;
  private loading = false;
  private version = 0;
  private gallery: ReturnType<typeof createImageGallery> | null = null;
  private galleryController: AbortController | null = null;
  private selectedId: string | null = null;

  mount(container: HTMLElement): void {
    this.unmount();
    this.container = container;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.scope = imageChatContext()?.scope ?? null;
    this.cursors = [null];
    container.innerHTML = `<section class="image-review">
      <div class="review-toolbar"><nav class="anchor-tabs" aria-label="图片范围"><button type="button" data-review-scope="current">当前角色卡</button><button type="button" data-review-scope="all">全部角色卡</button></nav><button type="button" class="text-button" data-review-action="refresh">刷新</button></div>
      <p class="config-status" data-review-context></p><p class="config-status" data-review-status role="status">正在读取图片…</p>
      <div class="review-grid" data-review-grid></div>
      <nav class="review-pagination" aria-label="图片翻页"><button type="button" class="secondary" data-review-action="previous">上一页</button><span data-review-page></span><button type="button" class="secondary" data-review-action="next">下一页</button></nav>
    </section>`;
    container.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.dataset.reviewScope) {
        this.all = button.dataset.reviewScope === 'all';
        this.cursors = [null];
        void this.load();
      }
      if (button.dataset.reviewImage) this.open(button.dataset.reviewImage);
      if (this.loading) return;
      if (button.dataset.reviewAction === 'refresh') { this.cursors = [null]; void this.load(); }
      if (button.dataset.reviewAction === 'previous' && this.cursors.length > 1) { this.cursors.pop(); void this.load(); }
      if (button.dataset.reviewAction === 'next' && this.more && this.next) { this.cursors.push(this.next); void this.load(); }
    }, { signal });
    this.stopHistory = onImageHistoryChanged(change => {
      if (change.savedId) {
        if (!this.gallery?.element.open && this.cursors.length === 1) void this.load();
        else this.message('有新图片，点击“刷新”查看。');
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
      if (!this.gallery?.element.open) void this.load();
    });
    this.stopChat = watchChatRendering(() => {
      const scope = imageChatContext()?.scope ?? null;
      if (scope === this.scope) return;
      this.scope = scope;
      if (!this.all) { this.cursors = [null]; void this.load(); }
    });
    void this.load();
  }

  unmount(): void {
    this.version++;
    this.stopHistory();
    this.stopChat();
    this.controller?.abort();
    this.controller = null;
    this.release();
    this.container = null;
    this.loading = false;
  }

  private release(): void {
    this.galleryController?.abort();
    this.galleryController = null;
    this.gallery?.element.remove();
    this.gallery = null;
    this.selectedId = null;
    this.items.forEach(item => URL.revokeObjectURL(item.url));
    this.items = [];
  }

  private message(text: string, error = false): void {
    const status = this.container?.querySelector<HTMLElement>('[data-review-status]');
    if (status) { status.textContent = text; status.classList.toggle('is-error', error); }
  }

  private async load(): Promise<void> {
    if (!this.container) return;
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
      const result = await loadImageHistoryPage(this.all ? null : this.scope, this.cursors.at(-1) ?? null);
      if (version !== this.version || !this.container) return;
      this.items = result.entries.map(entry => ({ entry, url: URL.createObjectURL(entry.blob) }));
      this.next = result.next;
      this.more = result.more;
      this.message(this.items.length ? '点击图片可全屏查看、下载、删除或查看生成属性。' : '这里还没有保存的图片。');
    } catch (error) {
      if (version === this.version) this.message(error instanceof Error ? error.message : '图片读取失败，请刷新重试。', true);
    } finally {
      if (version === this.version) { this.loading = false; this.render(); }
    }
  }

  private render(): void {
    const container = this.container;
    if (!container) return;
    container.querySelectorAll<HTMLButtonElement>('[data-review-scope]').forEach(button => {
      button.setAttribute('aria-pressed', String((button.dataset.reviewScope === 'all') === this.all));
    });
    const context = imageChatContext();
    container.querySelector('[data-review-context]')!.textContent = `${this.all ? '全部角色卡与未归属图片' : context?.name ?? '当前角色卡'} · 本机保存 · 每页最多 12 张`;
    const grid = container.querySelector<HTMLElement>('[data-review-grid]')!;
    grid.replaceChildren();
    for (const { entry, url } of this.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'review-card';
      button.dataset.reviewImage = entry.id;
      const image = document.createElement('img');
      image.src = url; image.alt = historyTitle(entry); image.loading = 'lazy'; image.decoding = 'async';
      const title = document.createElement('strong');
      title.textContent = historyTitle(entry);
      const source = document.createElement('span');
      source.className = 'muted';
      let label = entry.sourceName;
      if (!label) {
        try { const scope = JSON.parse(historyScope(entry.markerKey)); label = String(scope[1] ?? '未归属图片').replace(/\.png$/i, ''); }
        catch { label = '未归属图片'; }
      }
      source.textContent = `${label} · ${new Date(entry.createdAt).toLocaleString()} · ${(entry.blob.size / 1024 / 1024).toFixed(1)} MB`;
      button.append(image, title, source);
      grid.append(button);
    }
    container.querySelector('[data-review-page]')!.textContent = `第 ${this.cursors.length} 页 · ${this.items.length} 张`;
    container.querySelector<HTMLButtonElement>('[data-review-action="previous"]')!.disabled = this.loading || this.cursors.length <= 1;
    container.querySelector<HTMLButtonElement>('[data-review-action="next"]')!.disabled = this.loading || !this.more;
    container.querySelector<HTMLButtonElement>('[data-review-action="refresh"]')!.disabled = this.loading;
  }

  private open(id: string): void {
    const selected = this.items.find(item => item.entry.id === id);
    if (!selected || !this.container) return;
    this.galleryController?.abort();
    this.gallery?.element.remove();
    this.galleryController = new AbortController();
    this.selectedId = id;
    const gallery = createImageGallery(historyTitle(selected.entry), this.galleryController.signal, {
      onSelect: next => {
        this.selectedId = next;
        const item = this.items.find(item => item.entry.id === next);
        if (item) { gallery.setSummary(historyTitle(item.entry)); gallery.setImages(this.items, next); }
      },
      onDelete: async next => { await deleteImageHistory(next); },
    });
    this.gallery = gallery;
    this.container.append(gallery.element);
    gallery.setImages(this.items, id);
    gallery.open();
  }
}
