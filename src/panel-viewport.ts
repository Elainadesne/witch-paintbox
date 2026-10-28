// Keep the settings dialog inside the visible mobile viewport without changing the host page.
const MOBILE_PANEL = '(max-width: 640px), (pointer: coarse) and (max-width: 1100px)';

export function bindPanelViewport(panel: HTMLDialogElement, signal: AbortSignal): { refresh(): void } {
  const view = window.visualViewport;
  const mobile = window.matchMedia(MOBILE_PANEL);
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)';
  panel.append(probe);
  let frame = 0;
  let focusTimer = 0;
  const properties = ['vv-left', 'vv-top', 'vv-width', 'vv-height', 'safe-top', 'safe-right', 'safe-bottom', 'safe-left'];
  const clear = () => {
    properties.forEach(name => panel.style.removeProperty(`--panel-${name}`));
    delete panel.dataset.compactViewport;
  };
  const zoomed = () => !!view && Math.abs(view.scale - 1) > 0.05;

  function revealFocusedField() {
    const root = panel.getRootNode() as Document | ShadowRoot;
    const field = root.activeElement;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
    const content = panel.querySelector<HTMLElement>('.content');
    if (!content?.contains(field)) return;
    const area = content.getBoundingClientRect(), rect = field.getBoundingClientRect();
    const top = area.top + 12, bottom = area.bottom - 12;
    if (bottom <= top) return;
    // A tall editor may fill the available space. Do not repeatedly jump it to one end or move its caret.
    if (rect.height > bottom - top && rect.bottom > top && rect.top < bottom) return;
    const delta = rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
    if (delta) content.scrollTop += delta;
  }

  function refresh() {
    if (signal.aborted || !panel.open) return;
    if (!mobile.matches) { clear(); return; }
    // Let the user zoom and pan normally instead of chasing the zoomed viewport with a resized dialog.
    if (zoomed()) return;
    const width = view?.width ?? window.innerWidth;
    const height = view?.height ?? window.innerHeight;
    if (width <= 0 || height <= 0) return;
    const left = Math.max(0, view?.offsetLeft ?? 0), top = Math.max(0, view?.offsetTop ?? 0);
    panel.dataset.compactViewport = String(height < 500);
    const style = getComputedStyle(probe);
    const inset = (value: string) => Math.max(0, Number.parseFloat(value) || 0);
    const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    // Only reserve the part of the layout's unsafe edge still inside the visible rectangle.
    // In particular, the home-indicator inset must not be counted again above an open keyboard.
    const values: Record<string, number> = {
      'vv-left': left, 'vv-top': top, 'vv-width': width, 'vv-height': height,
      'safe-top': Math.min(height, Math.max(0, inset(style.paddingTop) - top)),
      'safe-left': Math.min(width, Math.max(0, inset(style.paddingLeft) - left)),
      'safe-right': Math.min(width, inset(style.paddingRight), Math.max(0, left + width - layoutWidth + inset(style.paddingRight))),
      'safe-bottom': Math.min(height, inset(style.paddingBottom), Math.max(0, top + height - layoutHeight + inset(style.paddingBottom))),
    };
    for (const [name, value] of Object.entries(values)) {
      panel.style.setProperty(`--panel-${name}`, `${Math.round(value * 100) / 100}px`);
    }
    revealFocusedField();
  }

  function schedule() {
    if (signal.aborted || !panel.open || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }

  function focusChanged() {
    schedule();
    clearTimeout(focusTimer);
    focusTimer = window.setTimeout(schedule, 300);
  }

  function cancel() {
    cancelAnimationFrame(frame); frame = 0;
    clearTimeout(focusTimer); focusTimer = 0;
  }

  view?.addEventListener('resize', schedule, { signal });
  view?.addEventListener('scroll', schedule, { signal });
  window.addEventListener('resize', schedule, { signal });
  window.addEventListener('orientationchange', schedule, { signal });
  window.addEventListener('pageshow', schedule, { signal });
  mobile.addEventListener('change', schedule, { signal });
  panel.addEventListener('focusin', focusChanged, { signal });
  panel.addEventListener('focusout', focusChanged, { signal });
  panel.addEventListener('close', cancel, { signal });
  signal.addEventListener('abort', () => { cancel(); clear(); probe.remove(); }, { once: true });
  return { refresh };
}
