import { ChatProcessor } from './chat-processor.js';
import { bindIllustrationPicker } from './illustration-picker.js';
import { emitPetEvent } from './pet-events.js';

export function bindLauncherMenu(
  launcher: HTMLButtonElement, root: ShadowRoot, signal: AbortSignal, configure: () => void,
  options: { anchor?: () => DOMRect } = {},
) {
  const menu = document.createElement('div');
  menu.id = 'witch-launcher-menu';
  menu.className = 'launcher-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '魔女画匣快捷菜单');
  menu.innerHTML = `<button type="button" data-process title="让预设 AI 为最新回复插入配图标记">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 11-11 3 3L7 23M14 3v4m-2-2h4M5 8v4m-2-2h4M20 3v4m-2-2h4"/></svg><span>AI生图</span></button>
    <button type="button" data-select><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h12M9 12h12M9 19h12M2 5l2 2 3-4M2 12l2 2 3-4M3 19h2"/></svg><span>指定插图</span></button>
    <button type="button" data-configure><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-7 0v6"/></svg><span>设置</span></button>
    <p role="status"></p><button type="button" data-cancel hidden>取消处理</button>`;
  root.append(menu);
  launcher.setAttribute('aria-controls', menu.id);
  const processButton = menu.querySelector<HTMLButtonElement>('[data-process]')!;
  const selectButton = menu.querySelector<HTMLButtonElement>('[data-select]')!;
  const cancelButton = menu.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const status = menu.querySelector('p')!;
  const processor = new ChatProcessor((message, busy, error, cancellable = true) => {
    status.textContent = message;
    status.classList.toggle('is-error', !!error);
    processButton.disabled = busy;
    selectButton.disabled = busy;
    cancelButton.hidden = !busy;
    cancelButton.disabled = !cancellable;
    launcher.classList.toggle('processing', busy);
    picker.report(message, busy, !!error, cancellable);
    if (!menu.hidden) place();
  });
  const picker = bindIllustrationPicker(root, signal, processor);
  function place() {
    const bounds = options.anchor?.() ?? launcher.getBoundingClientRect();
    const left = bounds.right + 10 + menu.offsetWidth <= window.innerWidth - 8
      ? bounds.right + 10 : bounds.left - menu.offsetWidth - 10;
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(bounds.top + bounds.height / 2 - menu.offsetHeight / 2, window.innerHeight - menu.offsetHeight - 8))}px`;
  }
  function close() {
    const wasOpen = !menu.hidden;
    menu.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    if (wasOpen) emitPetEvent({ type: 'ui', action: 'menu-close' });
  }
  function open() {
    if (launcher.hidden) return;
    const opening = menu.hidden;
    menu.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    place();
    menu.querySelector<HTMLButtonElement>('button:not(:disabled):not([hidden])')?.focus({ preventScroll: true });
    if (opening) emitPetEvent({ type: 'ui', action: 'menu-open' });
  }
  processButton.addEventListener('click', () => { void processor.process(); }, { signal });
  selectButton.addEventListener('click', () => { close(); picker.open(launcher); }, { signal });
  cancelButton.addEventListener('click', () => processor.cancel(), { signal });
  menu.querySelector('[data-configure]')!.addEventListener('click', () => { close(); configure(); }, { signal });
  document.addEventListener('pointerdown', event => {
    if (!event.composedPath().includes(menu) && !event.composedPath().includes(launcher)) close();
  }, { signal });
  root.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      launcher.focus();
    }
  }, { signal });
  window.addEventListener('resize', () => { if (!menu.hidden) place(); }, { signal });
  signal.addEventListener('abort', () => { processor.cancel(); menu.remove(); }, { once: true });
  return { open, close, toggle: () => menu.hidden ? open() : close() };
}
