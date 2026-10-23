import {
  loadAnchors, saveAnchor, deleteAnchor, onAnchorsChanged, newAnchorId,
  ANCHOR_NAME_LIMIT, ANCHOR_TAG_LIMIT, ANCHOR_PORTRAIT_LIMIT, type CharacterAnchor,
} from './anchor-store.js';
import { getCurrentRoundImages, type CurrentRoundImage } from './current-images.js';
import { onImageHistoryChanged } from './image-history.js';
import { watchChatRendering } from './chat-host.js';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Keep weighted groups together when the user selects tags by hand. */
function selectableTags(prompt: string): string[] {
  const tags: string[] = [];
  const stack: string[] = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' };
  let weighted = false;
  let start = 0;
  for (let i = 0; i < prompt.length; i++) {
    const character = prompt[i];
    if (character === '\\') { i++; continue; }
    if (prompt.slice(i, i + 2) === '::') { weighted = !weighted; i++; continue; }
    if (weighted) continue;
    if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack.at(-1)) stack.pop();
    else if (!stack.length && /[,，\r\n]/.test(character)) {
      const tag = prompt.slice(start, i).trim();
      if (tag) tags.push(tag);
      start = i + 1;
    }
  }
  const tail = prompt.slice(start).trim();
  if (tail) tags.push(tail);
  return tags;
}

export class AnchorConfig {
  private container: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private roundRequest = 0;
  private anchorsRequest = 0;
  private tab: 'round' | 'anchors' = 'round';
  private anchors: CharacterAnchor[] = [];
  private round: CurrentRoundImage[] = [];
  private roundNotice = '正在读取本轮图片…';
  private roundError = false;
  private anchorsError = '';
  private draft: CharacterAnchor | null = null;
  private sourcePrompt = '';
  private dirty = false;
  private busy = false;
  private deleting = false;
  private picker: { tag: string; keep: boolean }[] | null = null;
  private urls: string[] = [];
  private notice = '';
  private failed = false;

  get hasPendingWrites(): boolean { return this.busy; }

  mount(container: HTMLElement): void {
    this.unmount();
    this.container = container;
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    container.addEventListener('click', event => { void this.click(event); }, { signal });
    container.addEventListener('input', event => this.edit(event), { signal });
    container.addEventListener('change', event => this.change(event), { signal });
    this.unsubscribe = [
      onAnchorsChanged(() => { void this.refreshAnchors(); }),
      onImageHistoryChanged(() => this.scheduleRound()),
      watchChatRendering(() => this.scheduleRound()),
    ];
    this.round = [];
    this.roundNotice = '正在读取本轮图片…';
    this.render();
    void this.refreshAnchors();
    void this.refreshRound();
  }

  unmount(): void {
    this.listeners?.abort();
    this.unsubscribe.splice(0).forEach(stop => stop());
    clearTimeout(this.timer);
    this.roundRequest++;
    this.anchorsRequest++;
    this.releaseUrls();
    this.container = null;
  }

  destroy(): void { this.unmount(); }

  private releaseUrls(): void {
    this.urls.splice(0).forEach(url => URL.revokeObjectURL(url));
  }

  private image(blob: Blob | null, className: string): string {
    if (!blob) return `<span class="${className} anchor-no-image" aria-label="尚未设置角色图">✦</span>`;
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    return `<img class="${className}" src="${url}" alt="" loading="lazy">`;
  }

  private message(text: string, error = false): void {
    this.notice = text;
    this.failed = error;
    const node = this.container?.querySelector<HTMLElement>('[data-anchor-status]');
    if (node) { node.textContent = text; node.classList.toggle('is-error', error); }
  }

  private scheduleRound(): void {
    clearTimeout(this.timer);
    this.roundRequest++;
    this.round = [];
    this.roundNotice = '正在读取本轮图片…';
    this.roundError = false;
    if (this.tab === 'round') this.render();
    this.timer = setTimeout(() => { void this.refreshRound(); }, 180);
  }

  private async refreshRound(): Promise<void> {
    const request = ++this.roundRequest;
    try {
      const result = await getCurrentRoundImages();
      if (!this.container || request !== this.roundRequest) return;
      this.round = result.images;
      this.roundNotice = result.images.length ? '' : '本轮还没有已保存的图片。先点击最新 AI 回复中的“生成图片”，再来挑选角色。';
      this.roundError = false;
    } catch (error) {
      if (!this.container || request !== this.roundRequest) return;
      this.round = [];
      this.roundNotice = error instanceof Error ? error.message : '无法读取本轮图片，请重试。';
      this.roundError = true;
    }
    if (this.tab === 'round') this.render();
  }

  private async refreshAnchors(): Promise<void> {
    const request = ++this.anchorsRequest;
    try {
      const anchors = await loadAnchors();
      if (!this.container || request !== this.anchorsRequest) return;
      this.anchors = anchors;
      this.anchorsError = '';
    } catch (error) {
      if (!this.container || request !== this.anchorsRequest) return;
      this.anchorsError = error instanceof Error ? error.message : '无法读取角色，请重试。';
    }
    if (this.tab === 'anchors' && !this.draft && !this.busy) this.render();
  }

  private render(): void {
    if (!this.container) return;
    this.releaseUrls();
    this.container.innerHTML = `<div class="image-settings anchor-settings">
      <nav class="anchor-tabs" aria-label="标签锚定页面">
        <button type="button" data-anchor-tab="round" aria-pressed="${this.tab === 'round'}">本轮生图</button>
        <button type="button" data-anchor-tab="anchors" aria-pressed="${this.tab === 'anchors'}">锚定配置</button>
      </nav>
      ${this.tab === 'round' ? this.roundView() : this.draft ? this.editorView() : this.libraryView()}
      <p class="config-status${this.failed ? ' is-error' : ''}" data-anchor-status role="status">${escape(this.notice)}</p>
    </div>`;
  }

  private roundView(): string {
    return `<div class="anchor-toolbar"><p class="config-status">当前聊天最新 AI 回复的已生成图片。点击图片与 tag，配置单个角色。</p>
      <button type="button" class="text-button" data-anchor-action="refresh">刷新</button></div>
      ${this.roundNotice ? `<p class="anchor-empty${this.roundError ? ' is-error' : ''}" role="status">${escape(this.roundNotice)}</p>` : ''}
      <div class="anchor-round-grid">${this.round.map(item => `<button type="button" class="anchor-image-card" data-anchor-image="${escape(item.entry.id)}">
        ${this.image(item.entry.blob, 'anchor-round-image')}
        <span class="anchor-card-caption"><strong>${escape(item.summary)}</strong><span class="anchor-tag-excerpt">${escape(item.entry.positive)}</span><span class="anchor-card-action">配置角色 →</span></span>
      </button>`).join('')}</div>`;
  }

  private libraryView(): string {
    return `<div class="anchor-toolbar"><p class="config-status">角色名展开为固定外貌与当前服装；角色与服装分别保存。</p>
      <button type="button" class="text-button" data-anchor-action="new">新建角色</button></div>
      ${this.anchorsError ? `<p class="anchor-empty is-error" role="alert">${escape(this.anchorsError)}</p><button type="button" class="text-button" data-anchor-action="reload">重新读取</button>` : ''}
      ${!this.anchors.length && !this.anchorsError ? '<p class="anchor-empty">还没有锚定角色。可以从“本轮生图”挑一张图片，也可以直接新建。</p>' : ''}
      <div class="anchor-library">${this.anchors.map(anchor => `<article class="anchor-record">
        <button type="button" class="anchor-character" data-anchor-id="${escape(anchor.id)}">
          ${this.image(anchor.portrait, 'anchor-portrait')}
          <span><strong>${escape(anchor.name)}</strong><span class="anchor-tag-excerpt">${escape(anchor.appearance)}</span></span>
          <span class="anchor-edit-label">编辑</span>
        </button>
        <ul class="anchor-wardrobe">${anchor.outfits.map(outfit => `<li><button type="button" data-anchor-id="${escape(anchor.id)}" data-anchor-outfit="${escape(outfit.id)}"><span>${escape(outfit.name)}</span>${anchor.selectedOutfitId === outfit.id ? '<small>当前服装</small>' : ''}</button></li>`).join('')}
          <li><button type="button" class="anchor-add-outfit" data-anchor-id="${escape(anchor.id)}" data-anchor-outfit="new">＋ 添加服装</button></li>
        </ul>
      </article>`).join('')}</div>`;
  }

  private editorView(): string {
    const draft = this.draft!;
    const exists = this.anchors.some(anchor => anchor.id === draft.id);
    return `<div class="anchor-toolbar"><h3 class="subsection-title">${exists ? '编辑角色' : '配置角色'}</h3><button type="button" class="text-button" data-anchor-action="back"${this.busy ? ' disabled' : ''}>返回列表</button></div>
      <fieldset class="anchor-editor"${this.busy ? ' disabled' : ''}>
        <div class="anchor-identity">${this.image(draft.portrait, 'anchor-editor-portrait')}
          <div class="anchor-identity-fields"><label class="config-field"><span>角色中文名称</span><input type="text" data-anchor-field="name" value="${escape(draft.name)}" maxlength="${ANCHOR_NAME_LIMIT}" placeholder="例如：莎莉" autocomplete="off"></label>
            <label class="config-field"><span>角色图</span><input type="file" accept="image/png,image/jpeg,image/webp" data-anchor-portrait></label>
            ${draft.portrait ? '<button type="button" class="text-button" data-anchor-action="remove-portrait">移除角色图</button>' : ''}
          </div>
        </div>
        <label class="config-field"><span>固定外貌 · 不包含服装、动作与场景</span><textarea rows="5" data-anchor-field="appearance" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(draft.appearance)}</textarea></label>
        <div class="anchor-toolbar anchor-tag-tools"><p class="config-status">手动保留发色、发型、瞳色等外貌 tag，确认后再保存。</p><button type="button" class="text-button" data-anchor-action="pick-tags">筛选外貌 tag</button></div>
        ${this.pickerView()}
        ${this.sourcePrompt ? `<details class="anchor-source"><summary>查看这张图片的完整生成 tag</summary><pre>${escape(this.sourcePrompt)}</pre></details>` : ''}
        <section class="anchor-outfit-section"><div class="anchor-toolbar"><h3 class="subsection-title">服装库</h3><button type="button" class="text-button" data-anchor-action="add-outfit">＋ 添加服装</button></div>
          <label class="config-field"><span>当前服装</span><select data-anchor-field="selectedOutfitId"><option value="">只用固定外貌</option>${draft.outfits.map(outfit => `<option value="${escape(outfit.id)}"${draft.selectedOutfitId === outfit.id ? ' selected' : ''}>${escape(outfit.name || '未命名服装')}</option>`).join('')}</select></label>
          <div class="anchor-outfit-editors">${draft.outfits.map(outfit => `<details class="anchor-outfit" data-outfit="${escape(outfit.id)}"${outfit.id === draft.selectedOutfitId || !outfit.name ? ' open' : ''}>
            <summary>${escape(outfit.name || '新服装')}</summary>
            <div class="anchor-outfit-fields"><label class="config-field"><span>服装名称</span><input type="text" data-outfit-field="name" maxlength="${ANCHOR_NAME_LIMIT}" value="${escape(outfit.name)}" placeholder="例如：日常装"></label>
              <label class="config-field"><span>服装 tag</span><textarea rows="3" data-outfit-field="tags" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(outfit.tags)}</textarea></label>
              <button type="button" class="text-button anchor-danger" data-anchor-action="remove-outfit">删除这套服装</button></div>
          </details>`).join('')}</div>
        </section>
        <p class="anchor-usage">在生图 tag 中单独填写角色名，即可使用固定外貌和当前服装。填写“角色名/服装名”可指定服装，“角色名/无服装”只展开外貌。用逗号与其他 tag 分隔。</p>
        <div class="anchor-save-line"><button type="button" class="primary" data-anchor-action="save"${!this.dirty ? ' disabled' : ''}>${this.busy ? '保存中…' : '保存角色'}</button>
          ${exists ? '<button type="button" class="text-button anchor-danger" data-anchor-action="delete">删除角色</button>' : ''}</div>
        ${this.deleting ? '<div class="anchor-delete-confirm" role="alert"><p>删除这个角色及其服装库？原生成图片会保留。</p><button type="button" class="text-button anchor-danger" data-anchor-action="confirm-delete">确认删除</button><button type="button" class="text-button" data-anchor-action="cancel-delete">取消</button></div>' : ''}
      </fieldset>`;
  }

  private pickerView(): string {
    if (!this.picker) return '';
    return `<section class="anchor-tag-picker" aria-label="选择要保留的外貌标签"><p class="config-status">勾选要留下的 tag；带括号的权重组会作为整体保留，也可在上方直接编辑。</p>
      <div class="anchor-tag-list">${this.picker.map((item, index) => `<label><input type="checkbox" data-tag-index="${index}"${item.keep ? ' checked' : ''}><span>${escape(item.tag)}</span></label>`).join('')}</div>
      <div class="anchor-picker-actions"><button type="button" class="text-button" data-anchor-action="select-none">取消全选</button><button type="button" class="text-button" data-anchor-action="apply-tags">应用所选</button><button type="button" class="text-button" data-anchor-action="close-picker">收起</button></div></section>`;
  }

  private markDirty(): void {
    this.dirty = true;
    this.deleting = false;
    const button = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="save"]');
    if (button) button.disabled = this.busy;
    this.container?.querySelector('.anchor-delete-confirm')?.remove();
    this.message('尚未保存。');
  }

  private edit(event: Event): void {
    const field = event.target;
    if (!this.draft || this.busy || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
    const key = field.dataset.anchorField;
    if (key === 'name' || key === 'appearance' || key === 'selectedOutfitId') {
      this.draft[key] = field.value;
      if (key === 'appearance') { this.picker = null; this.container?.querySelector('.anchor-tag-picker')?.remove(); }
      this.markDirty();
    }
    const outfitKey = field.dataset.outfitField;
    if (outfitKey === 'name' || outfitKey === 'tags') {
      const details = field.closest<HTMLDetailsElement>('[data-outfit]');
      const outfit = this.draft.outfits.find(item => item.id === details?.dataset.outfit);
      if (!outfit) return;
      outfit[outfitKey] = field.value;
      if (outfitKey === 'name') {
        details!.querySelector('summary')!.textContent = field.value || '新服装';
        const option = Array.from(this.container!.querySelectorAll<HTMLOptionElement>('[data-anchor-field="selectedOutfitId"] option')).find(item => item.value === outfit.id);
        if (option) option.textContent = field.value || '未命名服装';
      }
      this.markDirty();
    }
    if (field instanceof HTMLInputElement && field.dataset.tagIndex !== undefined && this.picker) {
      const tag = this.picker[Number(field.dataset.tagIndex)];
      if (tag) tag.keep = field.checked;
    }
  }

  private change(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-anchor-portrait') || !this.draft || this.busy) return;
    const file = input.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > ANCHOR_PORTRAIT_LIMIT) {
      input.value = '';
      this.message('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片。', true);
      return;
    }
    this.draft.portrait = file;
    this.markDirty();
    this.render();
  }

  private begin(anchor?: CharacterAnchor, source?: CurrentRoundImage): boolean {
    if (this.draft && this.dirty && !window.confirm('放弃当前尚未保存的角色修改？')) return false;
    this.draft = anchor ? structuredClone(anchor) : {
      id: newAnchorId(), name: '', appearance: source?.entry.positive ?? '', outfits: [],
      selectedOutfitId: '', portrait: source?.entry.blob ?? null, updatedAt: Date.now(),
    };
    this.sourcePrompt = source?.entry.positive ?? '';
    this.dirty = !anchor;
    this.deleting = false;
    this.picker = null;
    this.tab = 'anchors';
    this.notice = '';
    this.failed = false;
    this.render();
    this.container?.querySelector<HTMLInputElement>('[data-anchor-field="name"]')?.focus({ preventScroll: true });
    return true;
  }

  private addOutfit(): void {
    if (!this.draft) return;
    const outfit = { id: newAnchorId(), name: '', tags: '' };
    this.draft.outfits.push(outfit);
    this.markDirty();
    this.render();
    const details = Array.from(this.container!.querySelectorAll<HTMLDetailsElement>('[data-outfit]')).find(item => item.dataset.outfit === outfit.id);
    details?.querySelector<HTMLInputElement>('input')?.focus();
  }

  private async commit(remove = false): Promise<void> {
    const draft = this.draft;
    if (!draft || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const snapshot = structuredClone(draft);
      snapshot.updatedAt = Date.now();
      if (remove) await deleteAnchor(snapshot.id);
      else await saveAnchor(snapshot);
      // Only update the matching editor; navigation may have unmounted it.
      if (this.draft === draft) {
        this.anchors = remove ? this.anchors.filter(item => item.id !== snapshot.id)
          : [...this.anchors.filter(item => item.id !== snapshot.id), { ...snapshot, name: snapshot.name.trim(), appearance: snapshot.appearance.trim() }];
        this.draft = null;
        this.sourcePrompt = '';
        this.picker = null;
        this.dirty = false;
        this.deleting = false;
        this.message(remove ? '角色及服装库已删除。' : '角色与服装已保存在当前浏览器。');
      }
    } catch (error) {
      this.message(error instanceof Error ? error.message : '保存失败，修改仍保留在当前编辑页。', true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async click(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled || this.busy) return;
    const tab = button.dataset.anchorTab;
    if (tab === 'round' || tab === 'anchors') { this.tab = tab; this.render(); if (tab === 'round') void this.refreshRound(); return; }
    if (button.dataset.anchorImage) {
      const source = this.round.find(item => item.entry.id === button.dataset.anchorImage);
      if (source) this.begin(undefined, source);
      return;
    }
    if (button.dataset.anchorId) {
      const anchor = this.anchors.find(item => item.id === button.dataset.anchorId);
      if (!anchor) return;
      if (!this.begin(anchor)) return;
      if (button.dataset.anchorOutfit === 'new') this.addOutfit();
      else if (button.dataset.anchorOutfit) {
        const details = Array.from(this.container!.querySelectorAll<HTMLDetailsElement>('[data-outfit]')).find(item => item.dataset.outfit === button.dataset.anchorOutfit);
        if (details) { details.open = true; details.querySelector<HTMLInputElement>('input')?.focus(); }
      }
      return;
    }
    switch (button.dataset.anchorAction) {
      case 'refresh': await this.refreshRound(); break;
      case 'reload': await this.refreshAnchors(); break;
      case 'new': this.begin(); break;
      case 'back':
        if (this.dirty && !window.confirm('放弃当前尚未保存的角色修改？')) return;
        this.draft = null; this.picker = null; this.dirty = false; this.deleting = false; this.message(''); this.render(); break;
      case 'remove-portrait': if (this.draft) { this.draft.portrait = null; this.markDirty(); this.render(); } break;
      case 'add-outfit': this.addOutfit(); break;
      case 'remove-outfit': {
        if (!this.draft) return;
        const id = button.closest<HTMLElement>('[data-outfit]')?.dataset.outfit;
        this.draft.outfits = this.draft.outfits.filter(item => item.id !== id);
        if (this.draft.selectedOutfitId === id) this.draft.selectedOutfitId = '';
        this.markDirty(); this.render(); break;
      }
      case 'pick-tags': {
        if (!this.draft) return;
        const tags = selectableTags(this.draft.appearance);
        if (!tags.length) { this.message('先填写或从图片带入外貌 tag。', true); return; }
        if (tags.length > 512) { this.message('标签较多，请直接在外貌文本中编辑。', true); return; }
        this.picker = tags.map(tag => ({ tag, keep: true })); this.render(); break;
      }
      case 'select-none': this.picker?.forEach(item => { item.keep = false; }); this.render(); break;
      case 'apply-tags':
        if (!this.draft || !this.picker) return;
        if (!this.picker.some(item => item.keep)) { this.message('请至少保留一个外貌 tag。', true); return; }
        this.draft.appearance = this.picker.filter(item => item.keep).map(item => item.tag).join(', ');
        this.picker = null; this.markDirty(); this.render(); break;
      case 'close-picker': this.picker = null; this.render(); break;
      case 'save': await this.commit(); break;
      case 'delete': this.deleting = true; this.render(); break;
      case 'cancel-delete': this.deleting = false; this.render(); break;
      case 'confirm-delete': await this.commit(true); break;
    }
  }
}
