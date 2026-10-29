import type { PaintboxTheme } from './settings.js';

// 解析酒馆主题的明暗：主题文字亮就是深色主题。优先读 SillyTavern 的 --SmartThemeBodyColor，取不到时看 body 的实际文字色。
function luminance(color: string): number | null {
  const probe = document.createElement('span');
  probe.style.color = color;
  probe.style.display = 'none';
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  const parts = value.match(/[\d.]+/g)?.map(Number);
  if (!parts || parts.length < 3) return null;
  const [r, g, b] = parts.map(v => v / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function tavernIsDark(): boolean {
  const smart = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim();
  const text = luminance(smart || getComputedStyle(document.body).color);
  if (text !== null) return text > 0.4;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 把画匣色调写到宿主上（data-theme="day|night"）；跟随酒馆时监听主题切换。 */
export function bindPaintboxTheme(host: HTMLElement, preference: () => PaintboxTheme, signal: AbortSignal): () => void {
  let frame = 0;
  const apply = () => {
    frame = 0;
    const wanted = preference();
    const night = wanted === 'night' || (wanted === 'auto' && tavernIsDark());
    const next = night ? 'night' : 'day';
    if (host.dataset.theme !== next) host.dataset.theme = next;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  apply();
  // 酒馆换主题会改 <html>/<body> 的 style 或 class，或替换主题 <style>
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', schedule, { signal });
  window.addEventListener('witch-paintbox:preferences-changed', schedule, { signal });
  signal.addEventListener('abort', () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); }, { once: true });
  return schedule;
}
