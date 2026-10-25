/** Retry only unresolved floors when layout becomes available, without rewriting chat HTML. */
export function watchChatImageLayout(root: HTMLElement, retry: () => void) {
  const pending = new Set<HTMLElement>();
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const schedule = () => { if (pending.size) retry(); };
  const intersections = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting && pending.has(entry.target as HTMLElement))) schedule();
    }) : null;
  const sizes = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => {
      if (entries.some(entry => pending.has(entry.target as HTMLElement))) schedule();
    }) : null;
  const resume = () => { if (doc.visibilityState === 'visible') schedule(); };
  const reveal = (event: Event) => {
    if ('skipped' in event && event.skipped === true) return;
    schedule();
  };
  // CSS content-visibility changes do not emit DOM mutations. Intersection and
  // resize observers also cover WebViews without contentvisibilityautostatechange.
  root.addEventListener('contentvisibilityautostatechange', reveal, true);
  view?.addEventListener('resize', schedule);
  doc.addEventListener('visibilitychange', resume);

  return {
    update(floors: Set<HTMLElement>) {
      for (const floor of pending) {
        if (floors.has(floor) && floor.isConnected) continue;
        intersections?.unobserve(floor);
        sizes?.unobserve(floor);
        pending.delete(floor);
      }
      for (const floor of floors) {
        if (pending.has(floor) || !floor.isConnected) continue;
        pending.add(floor);
        intersections?.observe(floor);
        sizes?.observe(floor);
      }
    },
    dispose() {
      pending.clear();
      intersections?.disconnect();
      sizes?.disconnect();
      root.removeEventListener('contentvisibilityautostatechange', reveal, true);
      view?.removeEventListener('resize', schedule);
      doc.removeEventListener('visibilitychange', resume);
    },
  };
}
