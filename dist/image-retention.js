import { deleteExpiredImages } from './image-history.js';
import { currentPreferences } from './settings.js';
let status = '自动清理关着。';
export function imageRetentionStatus() { return status; }
/** Runs only while the extension is open; expired records are caught up on the next launch. */
export function bindImageRetention(signal) {
    let running = false;
    let days = currentPreferences().imageRetentionDays;
    let revision = 0;
    const report = (text) => {
        status = text;
        window.dispatchEvent(new Event('witch-paintbox:cleanup-status'));
    };
    async function clean() {
        if (running || signal.aborted)
            return;
        if (!days) {
            report('自动清理已经关了。');
            return;
        }
        running = true;
        const version = revision;
        const before = Date.now() - days * 86_400_000;
        report('正在清掉过期旧图…');
        try {
            const count = await deleteExpiredImages(before, () => !signal.aborted && version === revision);
            if (version === revision && !signal.aborted)
                report(count ? `清掉了 ${count} 张旧图，只留着最近 ${days} 天的。` : `设了留最近 ${days} 天，眼下还没有过期的图。`);
        }
        catch (error) {
            if (version === revision && !signal.aborted)
                report(error instanceof Error ? error.message : '刚才没清成，下次打开画匣再顺手清一次。');
        }
        finally {
            running = false;
            if (version !== revision)
                void clean();
        }
    }
    window.addEventListener('witch-paintbox:preferences-changed', () => {
        const next = currentPreferences().imageRetentionDays;
        if (next === days)
            return;
        days = next;
        revision++;
        void clean();
    }, { signal });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible')
        void clean(); }, { signal });
    const interval = setInterval(() => { void clean(); }, 60 * 60 * 1000);
    signal.addEventListener('abort', () => clearInterval(interval), { once: true });
    void clean();
}
