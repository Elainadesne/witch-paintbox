import type { Position } from './settings.js';
import { onImageQueueChanged } from './image-queue.js';

export function bindLauncher(
  button: HTMLButtonElement,
  initial: Position | null,
  onMove: (position: Position) => void,
  onOpen: () => void,
  signal: AbortSignal,
  onDrag?: () => void,
) {
  let position: Position;
  let drag: { pointerId: number; x: number; y: number; origin: Position } | null = null;
  let moved = false;
  let suppressClick = false;
  const idleLabel = button.getAttribute('aria-label') ?? '';
  const idleTitle = button.title;
  const idleText = button.textContent;
  const stopQueue = onImageQueueChanged(({ generating, queued }) => {
    const status = `正在生图${queued ? ` · 还有 ${queued} 张排队` : ''}`;
    button.classList.toggle('generating', generating);
    button.textContent = generating ? '绘制中' : idleText;
    button.title = generating ? `${status} · 点击打开菜单` : idleTitle;
    button.setAttribute('aria-label', generating ? `${status}，${idleLabel}` : idleLabel);
    button.setAttribute('aria-busy', String(generating));
  });
  signal.addEventListener('abort', stopQueue, { once: true });

  function place(next: Position) {
    const margin = 12;
    position = {
      x: Math.max(margin, Math.min(next.x, window.innerWidth - button.offsetWidth - margin)),
      y: Math.max(margin, Math.min(next.y, window.innerHeight - button.offsetHeight - margin)),
    };
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
  }

  function reset() {
    place({ x: window.innerWidth - 76, y: window.innerHeight - 100 });
  }

  if (initial) place(initial);
  else reset();

  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...position } };
    moved = suppressClick = false;
    button.setPointerCapture(event.pointerId);
  }, { signal });

  button.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    if (!moved) onDrag?.();
    moved = true;
    button.classList.add('dragging');
    place({ x: drag.origin.x + dx, y: drag.origin.y + dy });
  }, { signal });

  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    suppressClick = moved || event.type === 'pointercancel';
    if (moved) onMove({ ...position });
    drag = null;
    button.classList.remove('dragging');
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
  }

  button.addEventListener('pointerup', endDrag, { signal });
  button.addEventListener('pointercancel', endDrag, { signal });
  button.addEventListener('lostpointercapture', endDrag, { signal });
  button.addEventListener('click', event => {
    const ignore = suppressClick && event.detail !== 0;
    suppressClick = false;
    if (!ignore) onOpen();
  }, { signal });

  button.addEventListener('contextmenu', event => event.preventDefault(), { signal });

  window.addEventListener('resize', () => place(position), { signal });
  return { reset, setPosition: place, getPosition: () => ({ ...position }) };
}
