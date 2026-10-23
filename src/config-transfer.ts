import { applyArchive, archiveKeyCount, exportArchive, MAX_ARCHIVE_BYTES, parseArchive, summarizeArchive, type ArchiveKind, type ParsedArchive } from './config-archive.js';
import type { TavernContext } from './settings.js';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export class ConfigTransfer {
  private container: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private request = 0;
  private phase: 'idle' | 'read' | 'export' | 'apply' = 'idle';
  private kind: ArchiveKind = 'all';
  private includeKeys = false;
  private pending: { filename: string; archive: ParsedArchive } | null = null;
  private notice = '';
  private error = false;

  constructor(private context: TavernContext, private onApplied: (kind: ArchiveKind) => void,
    private canApply: () => string | undefined) {}

  get isApplying(): boolean { return this.phase === 'apply'; }

  mount(container: HTMLElement): void {
    this.unmount(); this.container = container;
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    container.addEventListener('change', event => {
      const input = event.target;
      if (this.phase !== 'idle') return;
      if (input instanceof HTMLSelectElement && input.hasAttribute('data-transfer-kind')) {
        this.kind = input.value === 'artists' ? 'artists' : 'all'; this.render();
        this.container?.querySelector<HTMLElement>('[data-transfer-kind]')?.focus();
      } else if (input instanceof HTMLInputElement) {
        if (input.hasAttribute('data-transfer-keys')) this.includeKeys = input.checked;
        if (input.hasAttribute('data-transfer-file')) void this.readFile(input);
      }
    }, { signal });
    container.addEventListener('click', event => {
      if (!(event.target instanceof Element) || this.phase !== 'idle') return;
      const button = event.target.closest<HTMLButtonElement>('[data-transfer-action]');
      if (!button || button.disabled) return;
      if (button.dataset.transferAction === 'export') void this.download();
      if (button.dataset.transferAction === 'confirm') void this.apply();
      if (button.dataset.transferAction === 'cancel') { this.pending = null; this.notice = '已取消导入，现有配置未改动。'; this.error = false; this.render(); }
    }, { signal });
    this.render();
  }

  unmount(): void {
    this.listeners?.abort(); this.listeners = null; this.container = null;
    if (this.phase !== 'apply') {
      this.request++;
      if (this.phase !== 'idle') this.notice = '操作已取消，请重新选择文件或导出。';
      this.phase = 'idle';
    }
  }

  private render(): void {
    if (!this.container) return;
    const busy = this.phase !== 'idle';
    const archive = this.pending?.archive;
    this.container.innerHTML = `<div class="image-settings transfer-settings">
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">01</span><h2 class="section-title">配置导出</h2><p class="section-description">带走自己的画匣，或只分享喜欢的画师串。</p></header>
        <label class="config-field"><span>导出范围</span><select data-transfer-kind${busy ? ' disabled' : ''}><option value="all"${this.kind === 'all' ? ' selected' : ''}>所有配置 · 用于迁移</option><option value="artists"${this.kind === 'artists' ? ' selected' : ''}>仅画师串 · 用于分享</option></select></label>
        <p class="config-status">${this.kind === 'all' ? '包含生图 API、参数、模型 API、预设、画师串、标签锚定（含角色图）、世界书及使用偏好。' : '只包含命名画师配置、当前正负面词及选用状态，不包含接口、密钥或其他配置。'}</p>
        <label class="prompt-enable"><input type="checkbox" data-transfer-keys${this.kind === 'all' && this.includeKeys ? ' checked' : ''}${busy || this.kind === 'artists' ? ' disabled' : ''}>包含 API 密钥</label>
        ${this.kind === 'all' ? '<p class="config-status">勾选后，生图 API 与模型 API 的密钥会以明文写入文件。</p>' : ''}
        <div class="transfer-actions"><button type="button" class="text-button" data-transfer-action="export"${busy ? ' disabled' : ''}>${this.phase === 'export' ? '正在整理…' : '导出 JSON'}</button></div>
        <p class="config-status">导出已保存的配置；请先保存其他页面的修改。已生成的图片历史不包含在配置文件内。</p>
      </section>
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">02</span><h2 class="section-title">配置导入</h2><p class="section-description">先查看文件包含什么，再确认是否应用。</p></header>
        <label class="config-field"><span>选择魔女画匣配置文件 · JSON</span><input type="file" data-transfer-file accept=".json,application/json"${busy ? ' disabled' : ''}></label>
        <p class="config-status">最大 128 MiB。选择文件仅进行校验，不会立即覆盖配置。</p>
        ${archive ? `<section class="transfer-review" tabindex="-1" aria-label="导入内容确认">
          <h3>校验通过 · ${archive.kind === 'all' ? '完整配置' : '仅画师串'}</h3>
          <p class="config-status">${escape(this.pending!.filename)} · 导出于 ${escape(new Date(archive.exportedAt).toLocaleString())}</p>
          <ul class="transfer-summary">${summarizeArchive(archive).map(row => `<li><strong>${escape(row.title)}</strong><br><span>${escape(row.detail)}</span></li>`).join('')}
            <li><strong>API 密钥</strong><br><span>${archiveKeyCount(archive) ? `包含 ${archiveKeyCount(archive)} 处密钥，内容不在此展示。` : archive.kind === 'all' ? '未包含有效密钥；完整导入后需重新填写。' : '不包含；现有密钥保持不变。'}</span></li>
          </ul>
          <p class="config-status">${archive.kind === 'all' ? '确认后，文件中的全部配置将替换当前对应配置和编辑草稿，包括角色库与世界书库；生成图片历史保留。' : '确认后，将替换当前画师配置列表、正负面词及选用状态；接口、参数和其他配置保持不变。'}</p>
          <div class="transfer-actions"><button type="button" class="text-button" data-transfer-action="confirm"${busy ? ' disabled' : ''}>${this.isApplying ? '正在导入…' : '确认导入以上配置'}</button><button type="button" class="text-button" data-transfer-action="cancel"${busy ? ' disabled' : ''}>取消</button></div>
        </section>` : ''}
      </section>
      <p class="config-status${this.error ? ' is-error' : ''}" data-transfer-status role="status">${escape(this.notice)}</p>
    </div>`;
  }

  private async readFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    const request = ++this.request;
    this.pending = null; this.phase = 'read'; this.notice = '正在校验配置文件…'; this.error = false; this.render();
    try {
      if (file.size > MAX_ARCHIVE_BYTES) throw new Error('配置文件不能超过 128 MiB。');
      const source = await file.text();
      if (request !== this.request) return;
      const archive = parseArchive(source);
      this.pending = { filename: file.name, archive }; this.notice = '校验完成，请核对导入内容和覆盖范围。';
    } catch (error) {
      if (request !== this.request) return;
      this.error = true; this.notice = `校验失败，现有配置未改动：${error instanceof Error ? error.message : '无法读取文件。'}`;
    } finally {
      if (request === this.request) {
        this.phase = 'idle'; this.render();
        this.container?.querySelector<HTMLElement>('.transfer-review')?.focus();
      }
    }
  }

  private async download(): Promise<void> {
    const request = ++this.request, kind = this.kind, keys = kind === 'all' && this.includeKeys;
    this.phase = 'export'; this.notice = '正在整理已保存的配置…'; this.error = false; this.render();
    try {
      const blob = await exportArchive(kind, keys, this.context);
      if (request !== this.request) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.hidden = true; link.href = url;
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
      link.download = `魔女画匣-${kind === 'all' ? '完整配置' : '画师串'}${keys ? '-含密钥' : ''}-${stamp}.json`;
      try { document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
      this.notice = '已创建配置文件并交给浏览器下载。';
    } catch (error) {
      if (request !== this.request) return;
      this.error = true; this.notice = `导出失败：${error instanceof Error ? error.message : '无法创建文件。'}`;
    } finally { if (request === this.request) { this.phase = 'idle'; this.render(); } }
  }

  private async apply(): Promise<void> {
    if (!this.pending) return;
    const blocked = this.canApply();
    if (blocked) { this.notice = blocked; this.error = true; this.render(); return; }
    const archive = this.pending.archive;
    this.phase = 'apply'; this.notice = '正在导入已确认的配置…'; this.error = false; this.render();
    try {
      await applyArchive(archive, this.context);
      this.onApplied(archive.kind); this.pending = null;
      this.notice = archive.kind === 'all' ? '配置已导入，当前页面即可继续使用；使用偏好已提交酒馆保存。' : '画师串已导入，当前页面即可继续使用。';
    } catch (error) {
      this.error = true; this.notice = error instanceof Error ? error.message : '配置导入失败。';
    } finally { this.phase = 'idle'; this.render(); }
  }
}
