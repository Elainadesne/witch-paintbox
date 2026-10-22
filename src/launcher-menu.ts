import { ChatProcessor } from './chat-processor.js';

export function bindLauncherMenu(
  launcher: HTMLButtonElement, root: ShadowRoot, signal: AbortSignal, configure: () => void,
) {
  const menu = document.createElement('div');
  menu.className = 'launcher-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'AI 处理');
  menu.innerHTML = `<button type="button" data-process>AI 处理最新回复</button>
    <button type="button" data-cancel hidden>取消处理</button>
    <p role="status">按已保存的预设处理，校验通过后插入配图标记。</p>
    <div class="launcher-menu-footer"><button type="button" data-configure>预设配置</button><button type="button" data-close>关闭</button></div>`;
  root.append(menu);
  const processButton = menu.querySelector<HTMLButtonElement>('[data-process]')!;
  const cancelButton = menu.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const status = menu.querySelector('p')!;
  const processor = new ChatProcessor((message, busy, error, cancellable = true) => {
    status.textContent = message;
    status.classList.toggle('is-error', !!error);
    processButton.disabled = busy;
    cancelButton.hidden = !busy;
    cancelButton.disabled = !cancellable;
    launcher.classList.toggle('processing', busy);
  });
  function place() {
    const bounds = launcher.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(bounds.top - menu.offsetHeight - 10, window.innerHeight - menu.offsetHeight - 8))}px`;
  }
  function close() { menu.hidden = true; }
  function open() {
    menu.hidden = false;
    place();
    (processButton.disabled ? cancelButton : processButton).focus({ preventScroll: true });
  }
  processButton.addEventListener('click', () => { void processor.process(); }, { signal });
  cancelButton.addEventListener('click', () => processor.cancel(), { signal });
  menu.querySelector('[data-configure]')!.addEventListener('click', () => { close(); configure(); }, { signal });
  menu.querySelector('[data-close]')!.addEventListener('click', () => { close(); launcher.focus(); }, { signal });
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
  return { open, close };
}
