import { buildIllustrationUnits } from './illustration-selection.js';
import { textLines } from './image-text-regions.js';
import { bindPanelViewport } from './panel-viewport.js';
import { emitPetEvent } from './pet-events.js';
/** Reading and shopping-list state stay local; submitting uses the shared model pipeline. */
export function bindIllustrationPicker(root, signal, processor) {
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
        <div><p data-source>正在读取最新回复…</p><p class="muted" data-hint>点击自然段加入配图清单，每项一张。</p></div>
        <button type="button" class="secondary" data-refresh>重新读取正文</button>
        <div class="illustration-modes" role="group" aria-label="正文选取方式">
          <button type="button" data-mode="paragraph" aria-pressed="true">正文原文</button>
          <button type="button" data-mode="lines" aria-pressed="false">选取文段</button>
          <button type="button" data-mode="sentence" aria-pressed="false">选取句子</button>
        </div>
        <label class="illustration-grouping" hidden>每 <select aria-label="每段非空原文行数"><option value="3">3</option><option value="5">5</option><option value="8">8</option></select> 行一段</label>
      </div>
      <div class="illustration-picker-workspace">
        <div class="illustration-reading" tabindex="0" role="group" aria-label="点击正文加入配图清单"></div>
        <details class="illustration-cart-drawer" open>
          <summary>配图清单 <span data-drawer-count>0</span></summary>
          <aside class="illustration-cart" aria-label="配图清单">
            <div class="illustration-cart-heading"><h2>配图清单 <span data-cart-count>0</span></h2><button type="button" data-clear>清空</button></div>
            <p class="illustration-cart-empty muted">点击左侧正文，把想画的场景放进这里。</p>
            <ol class="illustration-cart-items"></ol>
          </aside>
        </details>
      </div>
      <footer class="illustration-picker-footer">
        <p class="status" data-status role="status" aria-live="polite"></p>
        <div class="illustration-picker-actions">
          <span class="muted" data-count>清单 0 项</span>
          <button type="button" class="secondary" data-cancel hidden>取消处理</button>
          <button type="button" class="primary" data-submit>提交配图清单</button>
        </div>
      </footer>
    </div>
  </div>`;
    root.append(panel);
    const viewport = bindPanelViewport(panel, signal);
    const reading = panel.querySelector('.illustration-reading');
    const source = panel.querySelector('[data-source]');
    const hint = panel.querySelector('[data-hint]');
    const status = panel.querySelector('[data-status]');
    const count = panel.querySelector('[data-count]');
    const cartList = panel.querySelector('.illustration-cart-items');
    const cartEmpty = panel.querySelector('.illustration-cart-empty');
    const drawer = panel.querySelector('.illustration-cart-drawer');
    const grouping = panel.querySelector('.illustration-grouping');
    const groupSize = grouping.querySelector('select');
    const modes = panel.querySelector('.illustration-modes');
    const desktop = window.matchMedia('(min-width: 760px)');
    const button = (name) => panel.querySelector(`[data-${name}]`);
    let cart = [];
    let units = [];
    let mode = 'paragraph';
    let selection = null;
    let loading = false;
    let running = false;
    let cancellable = true;
    let readVersion = 0;
    let opener = null;
    const range = (unit) => unit.pointIds.length === 1
        ? unit.pointIds[0] : `${unit.pointIds[0]}—${unit.pointIds.at(-1)}`;
    const samePoints = (left, right) => left.pointIds.length === right.pointIds.length
        && left.pointIds.every((id, index) => id === right.pointIds[index]);
    const overlaps = (unit) => cart.some(item => item.pointIds.some(id => unit.pointIds.includes(id)));
    function showStatus(message, error = false) {
        status.textContent = message;
        status.classList.toggle('is-error', error);
    }
    function syncControls() {
        const busy = loading || running || processor.busy;
        count.textContent = `清单 ${cart.length} 项 · ${cart.length} 张配图${selection ? ` · 最多 ${selection.capacity} 项` : ''}`;
        panel.querySelector('[data-cart-count]').textContent = String(cart.length);
        panel.querySelector('[data-drawer-count]').textContent = String(cart.length);
        button('submit').disabled = busy || !selection || !cart.length;
        button('clear').disabled = busy || !cart.length;
        button('refresh').disabled = busy;
        button('cancel').hidden = !running;
        button('cancel').disabled = !cancellable;
        button('close').disabled = running && !cancellable;
        groupSize.disabled = busy || !selection;
        grouping.hidden = mode !== 'lines';
        panel.setAttribute('aria-busy', String(busy));
        for (const control of Array.from(modes.querySelectorAll('button'))) {
            control.disabled = busy || !selection;
            control.setAttribute('aria-pressed', String(control.dataset.mode === mode));
        }
        for (const control of Array.from(reading.querySelectorAll('button[data-unit]'))) {
            const unit = units[Number(control.dataset.unit)];
            const added = cart.some(item => samePoints(item, unit));
            const overlap = !added && overlaps(unit);
            control.classList.toggle('is-added', added);
            control.classList.toggle('is-overlap', overlap);
            control.disabled = busy || !selection || added || overlap || cart.length >= selection.capacity;
            control.title = added ? '已加入配图清单，可在清单中移除' : overlap
                ? '与清单中已有范围重叠，请先移除对应项' : `加入配图清单 · ${range(unit)} · 第 ${unit.lineStart}—${unit.lineEnd} 行`;
        }
        cartList.querySelectorAll('button').forEach(control => { control.disabled = busy; });
    }
    function renderCart() {
        const fragment = document.createDocumentFragment();
        cart.forEach((item, index) => {
            const row = document.createElement('li');
            row.className = 'illustration-cart-item';
            const details = document.createElement('div');
            const title = document.createElement('strong');
            title.className = 'illustration-cart-range';
            title.textContent = `${index + 1}. ${range(item)}${item.pointIds.length > 1 ? ' · 范围内一张' : ' · 一张'}`;
            const excerpt = document.createElement('p');
            excerpt.className = 'illustration-cart-excerpt';
            excerpt.textContent = item.text.trim();
            excerpt.title = item.text.trim();
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.remove = String(index);
            remove.textContent = '×';
            remove.setAttribute('aria-label', `移除配图 ${index + 1}，${range(item)}`);
            details.append(title, excerpt);
            row.append(details, remove);
            fragment.append(row);
        });
        cartList.replaceChildren(fragment);
        cartEmpty.hidden = cart.length > 0;
        syncControls();
    }
    function renderReading() {
        if (!selection)
            return;
        const fraction = reading.scrollTop / Math.max(1, reading.scrollHeight - reading.clientHeight);
        units = buildIllustrationUnits(selection.plan, mode, Number(groupSize.value));
        reading.dataset.mode = mode;
        hint.textContent = mode === 'sentence' ? '点击一句话加入清单，配图插在这句话后。'
            : mode === 'lines' ? '按非空原文行分段；每项由 AI 在所选范围内选一处配图。'
                : '点击自然段加入配图清单，每项一张；切换选取方式会保留清单。';
        const fragment = document.createDocumentFragment();
        let passage;
        let previousLine = -1;
        units.forEach((unit, index) => {
            if (mode !== 'sentence' || !passage || previousLine !== unit.lineStart) {
                passage = document.createElement('div');
                passage.className = 'illustration-passage';
                fragment.append(passage);
            }
            previousLine = unit.lineEnd;
            const element = document.createElement(unit.pointIds.length ? 'button' : 'span');
            element.className = 'illustration-unit';
            // The original text remains inert, including markup and any code blocks.
            element.textContent = unit.text;
            if (element instanceof HTMLButtonElement) {
                element.type = 'button';
                element.dataset.unit = String(index);
                element.setAttribute('aria-label', `加入配图清单，第 ${unit.lineStart}—${unit.lineEnd} 行，${range(unit)}`);
            }
            passage.append(element);
        });
        reading.replaceChildren(fragment);
        reading.scrollTop = fraction * Math.max(0, reading.scrollHeight - reading.clientHeight);
        syncControls();
    }
    async function read() {
        const version = ++readVersion;
        loading = true;
        selection = null;
        units = [];
        cart = [];
        reading.replaceChildren();
        source.textContent = '正在读取最新回复…';
        showStatus('');
        renderCart();
        try {
            const current = await processor.prepareSelection();
            if (version !== readVersion || signal.aborted || !panel.open)
                return;
            selection = current;
            source.textContent = `最新 AI 回复 · ${textLines(current.plan.original).length} 行`;
            renderReading();
        }
        catch (error) {
            if (version !== readVersion || signal.aborted || !panel.open)
                return;
            source.textContent = '正文暂不可用';
            showStatus(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            if (version === readVersion) {
                loading = false;
                syncControls();
            }
        }
    }
    async function submit() {
        if (!selection || !cart.length || running || loading || processor.busy)
            return;
        running = true;
        cancellable = true;
        syncControls();
        try {
            const saved = await processor.process({ ...selection, items: cart });
            if (saved) {
                selection = null;
                cart = [];
                renderCart();
            }
        }
        finally {
            running = false;
            syncControls();
        }
    }
    function close() {
        if (running && !cancellable)
            return;
        if (running)
            processor.cancel();
        panel.close();
    }
    button('close').addEventListener('click', close, { signal });
    button('refresh').addEventListener('click', () => { void read(); }, { signal });
    button('clear').addEventListener('click', () => { cart = []; renderCart(); showStatus(''); }, { signal });
    button('cancel').addEventListener('click', () => processor.cancel(), { signal });
    button('submit').addEventListener('click', () => { void submit(); }, { signal });
    modes.addEventListener('click', event => {
        const target = event.target.closest('button[data-mode]');
        if (!target || target.disabled)
            return;
        mode = target.dataset.mode;
        renderReading();
    }, { signal });
    groupSize.addEventListener('change', renderReading, { signal });
    reading.addEventListener('click', event => {
        const target = event.target.closest('button[data-unit]');
        if (!target || target.disabled || loading || running || !selection)
            return;
        const unit = units[Number(target.dataset.unit)];
        if (!unit || !unit.pointIds.length || overlaps(unit) || cart.length >= selection.capacity)
            return;
        cart.push(unit);
        renderCart();
        showStatus(`已加入第 ${cart.length} 项。可继续选取场景，最后统一提交。`);
    }, { signal });
    cartList.addEventListener('click', event => {
        const target = event.target.closest('button[data-remove]');
        if (!target || target.disabled || loading || running)
            return;
        const index = Number(target.dataset.remove);
        cart.splice(index, 1);
        renderCart();
        cartList.querySelector(`button[data-remove="${Math.min(index, cart.length - 1)}"]`)?.focus({ preventScroll: true });
    }, { signal });
    const fitDrawer = () => { if (desktop.matches)
        drawer.open = true; };
    desktop.addEventListener('change', fitDrawer, { signal });
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); }, { signal });
    panel.addEventListener('close', () => {
        readVersion++;
        loading = false;
        emitPetEvent({ type: 'ui', action: 'panel-close' });
        if (opener?.isConnected)
            opener.focus({ preventScroll: true });
    }, { signal });
    signal.addEventListener('abort', () => { readVersion++; panel.remove(); }, { once: true });
    return {
        open(from) {
            if (panel.open || processor.busy || signal.aborted)
                return;
            opener = from;
            panel.showModal();
            viewport.refresh();
            fitDrawer();
            emitPetEvent({ type: 'ui', action: 'panel-open' });
            if (!selection)
                void read();
            else
                syncControls();
        },
        report(message, _busy, error = false, canCancel = true) {
            if (!running)
                return;
            cancellable = canCancel;
            showStatus(message, error);
            syncControls();
        },
    };
}
