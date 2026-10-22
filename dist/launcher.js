export function bindLauncher(button, initial, onMove, onOpen, signal) {
    let position;
    let drag = null;
    let moved = false;
    let suppressClick = false;
    function place(next) {
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
    if (initial)
        place(initial);
    else
        reset();
    button.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || drag)
            return;
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...position } };
        moved = suppressClick = false;
        button.setPointerCapture(event.pointerId);
    }, { signal });
    button.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId)
            return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!moved && Math.hypot(dx, dy) < 6)
            return;
        moved = true;
        button.classList.add('dragging');
        place({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    }, { signal });
    function endDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId)
            return;
        suppressClick = moved;
        if (moved)
            onMove({ ...position });
        drag = null;
        button.classList.remove('dragging');
        if (button.hasPointerCapture(event.pointerId))
            button.releasePointerCapture(event.pointerId);
    }
    button.addEventListener('pointerup', endDrag, { signal });
    button.addEventListener('pointercancel', endDrag, { signal });
    button.addEventListener('lostpointercapture', endDrag, { signal });
    button.addEventListener('click', event => {
        const ignore = suppressClick && event.detail !== 0;
        suppressClick = false;
        if (!ignore)
            onOpen();
    }, { signal });
    window.addEventListener('resize', () => place(position), { signal });
    return { reset, getPosition: () => ({ ...position }) };
}
