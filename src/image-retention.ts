import { deleteExpiredImages } from './image-history.js';
import { currentPreferences } from './settings.js';

let status = '自动清理已关闭。';
export function imageRetentionStatus(): string { return status; }

/** Runs only while the extension is open; expired records are caught up on the next launch. */
export function bindImageRetention(signal: AbortSignal): void {
  let running = false;
  let days = currentPreferences().imageRetentionDays;
  let revision = 0;
  const report = (text: string) => {
    status = text;
    window.dispatchEvent(new Event('witch-paintbox:cleanup-status'));
  };
  async function clean() {
    if (running || signal.aborted) return;
    if (!days) { report('自动清理已关闭。'); return; }
    running = true;
    const version = revision;
    const before = Date.now() - days * 86_400_000;
    report('正在清理过期图片…');
    try {
      const count = await deleteExpiredImages(before, () => !signal.aborted && version === revision);
      if (version === revision && !signal.aborted) report(count ? `已清理 ${count} 张过期图片，保留最近 ${days} 天。` : `保留最近 ${days} 天的图片，暂无过期图片。`);
    } catch (error) {
      if (version === revision && !signal.aborted) report(error instanceof Error ? error.message : '图片清理失败，下次打开时重试。');
    } finally {
      running = false;
      if (version !== revision) void clean();
    }
  }
  window.addEventListener('witch-paintbox:preferences-changed', () => {
    const next = currentPreferences().imageRetentionDays;
    if (next === days) return;
    days = next;
    revision++;
    void clean();
  }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void clean(); }, { signal });
  const interval = setInterval(() => { void clean(); }, 60 * 60 * 1000);
  signal.addEventListener('abort', () => clearInterval(interval), { once: true });
  void clean();
}
