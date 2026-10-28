import { ChatProcessor, type IllustrationSelection } from './chat-processor.js';
import { textLines } from './image-text-regions.js';
import { bindPanelViewport } from './panel-viewport.js';
import { emitPetEvent } from './pet-events.js';

/** The picker supplies positions to the shared model and insertion pipeline. */
export function bindIllustrationPicker(root: ShadowRoot, signal: AbortSignal, processor: ChatProcessor) {
  const panel = document.createElement('dialog');
  panel.className = 'panel illustration-picker';
  panel.setAttribute('aria-labelledby', 'illustration-picker-title');
  panel.innerHTML = `<div class="shell">
    <header class="window-header">
      <div class="window-brand"><p class="eyebrow">魔女画匣</p><h1 id="illustration-picker-title">指定插图</h1></div>
      <button type="button" class="close-button" data-close aria-label="关闭指定插图">×</button>
    </header>
    <div class="illustration-picker-body">
      <div class="illustration-picker-toolbar">
        <div><p data-source>正在读取最新回复…</p><p class="muted">按原文换行编号；勾选行末位置，可多选。</p></div>
        <button type="button" class="secondary" data-refresh>重新读取正文</button>
      </div>
      <div class="illustration-lines" tabindex="0" role="group" aria-label="正文与可选插入位置"></div>
      <footer class="illustration-picker-footer">
        <p class="status" data-status role="status" aria-live="polite"></p>
        <div class="illustration-picker-actions">
          <span class="muted" data-count>已选 0 行</span>
          <button type="button" class="secondary" data-clear>清空选择</button>
          <button type="button" class="secondary" data-cancel hidden>取消处理</button>
          <button type="button" class="primary" data-submit>生成插图提示词</button>
        </div>
      </footer>
    </div>
  </div>`;
  root.append(panel);
  const viewport = bindPanelViewport(panel, signal);
  const lines = panel.querySelector<HTMLElement>('.illustration-lines')!;
  const source = panel.querySelector<HTMLElement>('[data-source]')!;
  const status = panel.querySelector<HTMLElement>('[data-status]')!;
  const count = panel.querySelector<HTMLElement>('[data-count]')!;
  const button = (name: string) => panel.querySelector<HTMLButtonElement>(`[data-${name}]`)!;
  const selected = new Set<string>();
  let selection: IllustrationSelection | null = null;
  let loading = false;
  let running = false;
  let cancellable = true;
  let readVersion = 0;
  let opener: HTMLElement | null = null;

  function showStatus(message: string, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function syncControls() {
    const busy = loading || running || processor.busy;
    count.textContent = selection ? `已选 ${selected.size} 行 · 最多 ${selection.capacity} 处` : '已选 0 行';
    button('submit').disabled = busy || !selection || !selected.size;
    button('clear').disabled = busy || !selected.size;
    button('refresh').disabled = busy;
    button('cancel').hidden = !running;
    button('cancel').disabled = !cancellable;
    button('close').disabled = running && !cancellable;
    panel.setAttribute('aria-busy', String(busy));
    for (const checkbox of Array.from(lines.querySelectorAll<HTMLInputElement>('input'))) {
      checkbox.checked = selected.has(checkbox.value);
      checkbox.parentElement?.classList.toggle('is-selected', checkbox.checked);
      checkbox.disabled = busy || !selection || (!checkbox.checked && selected.size >= selection.capacity);
    }
  }

  function renderLines(current: IllustrationSelection) {
    const fragment = document.createDocumentFragment();
    const { original, points } = current.plan;
    let pointIndex = 0;
    textLines(original).forEach((line, index) => {
      let start = line.start;
      const row = (end: number, id?: string) => {
        const element = document.createElement(id ? 'label' : 'div');
        element.className = `illustration-line${id ? ' is-selectable' : ''}`;
        const tick = document.createElement(id ? 'input' : 'span');
        if (tick instanceof HTMLInputElement) {
          tick.type = 'checkbox';
          tick.value = id!;
          tick.setAttribute('aria-label', `第 ${index + 1} 行之后，${id}`);
        }
        const number = document.createElement('span');
        number.className = 'illustration-line-number';
        number.textContent = String(index + 1).padStart(3, '0');
        if (id) {
          const anchor = document.createElement('small');
          anchor.textContent = id;
          number.append(anchor);
        }
        const text = document.createElement('span');
        text.className = 'illustration-line-text';
        // Source HTML is displayed literally, never executed inside the picker.
        text.textContent = original.slice(start, Math.min(end, line.contentEnd)) || ' ';
        element.append(tick, number, text);
        fragment.append(element);
        start = end;
      };
      while (pointIndex < points.length && points[pointIndex].offset <= line.end) {
        const point = points[pointIndex++];
        if (point.offset > line.start) row(point.offset, point.id);
      }
      if (start < line.contentEnd || start === line.start) row(line.end);
    });
    lines.replaceChildren(fragment);
    lines.scrollTop = 0;
  }

  async function read() {
    const version = ++readVersion;
    loading = true;
    selection = null;
    selected.clear();
    lines.replaceChildren();
    source.textContent = '正在读取最新回复…';
    showStatus('');
    syncControls();
    try {
      const current = await processor.prepareSelection();
      if (version !== readVersion || signal.aborted || !panel.open) return;
      selection = current;
      source.textContent = `最新 AI 回复 · ${textLines(current.plan.original).length} 行`;
      renderLines(current);
      showStatus('沿用当前模型 API 与预设，要求 AI 为每个所选位置各生成一张配图。');
    } catch (error) {
      if (version !== readVersion || signal.aborted || !panel.open) return;
      source.textContent = '正文暂不可用';
      showStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (version === readVersion) { loading = false; syncControls(); }
    }
  }

  async function submit() {
    if (!selection || !selected.size || running || loading || processor.busy) return;
    running = true;
    cancellable = true;
    syncControls();
    try {
      const saved = await processor.process({ ...selection, pointIds: [...selected] });
      if (saved) {
        // The snapshot no longer matches the saved body. Require an explicit reread before another request.
        selection = null;
        selected.clear();
      }
    } finally {
      running = false;
      syncControls();
    }
  }

  function close() {
    if (running && !cancellable) return;
    if (running) processor.cancel();
    panel.close();
  }
  button('close').addEventListener('click', close, { signal });
  button('refresh').addEventListener('click', () => { void read(); }, { signal });
  button('clear').addEventListener('click', () => { selected.clear(); syncControls(); }, { signal });
  button('cancel').addEventListener('click', () => processor.cancel(), { signal });
  button('submit').addEventListener('click', () => { void submit(); }, { signal });
  lines.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || loading || running || !selection) return;
    if (input.checked && selected.size < selection.capacity) selected.add(input.value);
    else selected.delete(input.value);
    syncControls();
  }, { signal });
  panel.addEventListener('cancel', event => { event.preventDefault(); close(); }, { signal });
  panel.addEventListener('close', () => {
    readVersion++;
    loading = false;
    emitPetEvent({ type: 'ui', action: 'panel-close' });
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, { signal });
  signal.addEventListener('abort', () => { readVersion++; panel.remove(); }, { once: true });

  return {
    open(from: HTMLElement) {
      if (panel.open || processor.busy || signal.aborted) return;
      opener = from;
      panel.showModal();
      viewport.refresh();
      emitPetEvent({ type: 'ui', action: 'panel-open' });
      void read();
    },
    report(message: string, _busy: boolean, error = false, canCancel = true) {
      if (!running) return;
      cancellable = canCancel;
      showStatus(message, error);
      syncControls();
    },
  };
}
