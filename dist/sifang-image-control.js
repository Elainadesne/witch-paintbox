import { generateConfiguredImage } from './image-provider.js';
import { loadImageSettings } from './image-settings.js';
import { imageChatContext } from './chat-host.js';
import { createImageGallery } from './image-gallery.js';
import { loadImageHistory, saveImageHistory, deleteImageHistory, historyWasDeleted } from './image-history.js';
import { currentPreferences } from './settings.js';
import { awaitSifangChatRefresh } from './sifang-chat.js';
import { emitPetEvent, petEnd, petFault, petTaskId } from './pet-events.js';
/** The native view is transient. History, gallery and requests keep the plugin's existing storage and queue. */
export function createSifangImageControl(entry, root, hooks) {
    const controller = new AbortController();
    let request = null;
    let phase = 'idle';
    let status = '正在读取图片历史…';
    let history = [];
    let selectedId = null;
    let historyAvailable = false;
    let deletedBefore = 0;
    let veils = 0;
    let veiled = false;
    const deletedIds = new Set();
    const saves = new Map();
    const historyKey = entry.historyKey;
    const gallery = createImageGallery(entry.marker.summary, controller.signal, {
        onSelect(id) { selectedId = id; show(); },
        async onDelete(id) {
            const index = history.findIndex(item => item.entry.id === id);
            if (index < 0)
                return;
            await saves.get(id)?.catch(() => { });
            if (historyKey)
                await deleteImageHistory(id);
            if (controller.signal.aborted)
                return;
            remove({ deletedIds: [id] });
        },
    });
    root.append(gallery.element);
    function show() {
        if (controller.signal.aborted)
            return;
        gallery.setImages(history, selectedId);
        hooks.update({ state: phase, status, blob: history.find(item => item.entry.id === selectedId)?.entry.blob ?? null, veiled });
    }
    function report(text) { status = text; show(); }
    function remove(change) {
        change.deletedIds?.forEach(id => deletedIds.add(id));
        deletedBefore = Math.max(deletedBefore, change.before ?? 0);
        const removed = history.filter(item => historyWasDeleted(item.entry, change));
        history = history.filter(item => !historyWasDeleted(item.entry, change));
        if (!history.some(item => item.entry.id === selectedId))
            selectedId = history.at(-1)?.entry.id ?? null;
        if (removed.length && !request)
            status = history.length ? `剩余 ${history.length} 张图片` : '图片已清理，可重新生成。';
        show();
        removed.forEach(item => URL.revokeObjectURL(item.url));
    }
    // The desktop pet hides a new picture while it flies in; the frame shows it again after 4 s at the latest.
    function veil(stop) {
        const current = ++veils;
        veiled = true;
        show();
        const release = () => {
            if (veils !== current)
                return;
            stop();
            veiled = false;
            show();
        };
        setTimeout(release, 4000);
        return release;
    }
    const ready = (historyKey ? loadImageHistory(historyKey) : Promise.resolve([])).then(entries => {
        if (controller.signal.aborted)
            return;
        historyAvailable = true;
        history = entries.filter(item => item.createdAt >= deletedBefore && !deletedIds.has(item.id))
            .map(item => ({ entry: item, url: URL.createObjectURL(item.blob) }));
        selectedId = history.at(-1)?.entry.id ?? null;
        report(history.length ? `已恢复 ${history.length} 张图片 · 点击查看历史` : '');
    }).catch(error => report(error instanceof Error ? error.message : '图片历史读取失败。'));
    async function generate(autoSignal) {
        if (controller.signal.aborted || request || autoSignal?.aborted || !hooks.current())
            return;
        const job = new AbortController();
        const cancel = () => job.abort();
        controller.signal.addEventListener('abort', cancel, { once: true });
        autoSignal?.addEventListener('abort', cancel, { once: true });
        request = job;
        phase = 'queued';
        report('正在加入队列…');
        const pet = petTaskId();
        const source = autoSignal ? 'auto' : 'floor';
        const floor = hooks.floor();
        const endPet = petEnd();
        const petImage = { type: 'end', id: pet, task: 'image', source, floor };
        try {
            const settings = loadImageSettings();
            const parameters = settings.provider === 'openai' ? settings.openaiParameters : settings.parameters;
            emitPetEvent({ type: 'image', id: pet, source, phase: 'start', provider: settings.provider, floor, turn: true,
                summary: entry.marker.summary, again: history.length > 0, width: parameters.width, height: parameters.height });
            await ready;
            await awaitSifangChatRefresh();
            job.signal.throwIfAborted();
            if (!hooks.current()) {
                job.abort();
                job.signal.throwIfAborted();
            }
            const result = await generateConfiguredImage(settings, entry.marker.prompt, job.signal, progress => {
                if (!hooks.current() || (progress.state === 'generating' && hooks.pending())) {
                    job.abort();
                    return;
                }
                if (autoSignal && progress.state === 'generating' && (!currentPreferences().autoGenerateImages || !hooks.latest())) {
                    job.abort();
                    return;
                }
                phase = progress.state;
                report(progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在绘制…');
                emitPetEvent({ type: 'image', id: pet, source, phase: progress.state, floor,
                    position: progress.state === 'queued' ? progress.position : undefined, columns: progress.columns,
                    width: parameters.width, height: parameters.height });
            }, settings.positive);
            await awaitSifangChatRefresh();
            if (job.signal.aborted || controller.signal.aborted || !hooks.current()) {
                endPet({ ...petImage, result: 'dropped', paid: true, message: '' });
                return;
            }
            const item = {
                id: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`,
                ...result, markerKey: historyKey ?? entry.key, createdAt: Date.now(), scenePrompt: entry.marker.prompt,
                title: entry.marker.summary, sourceName: imageChatContext()?.name,
            };
            const save = historyKey ? saveImageHistory(item) : Promise.resolve();
            saves.set(item.id, save);
            history.push({ entry: item, url: URL.createObjectURL(item.blob) });
            selectedId = item.id;
            report('绘制完成，正在保存图片历史…');
            const place = hooks.watch();
            setTimeout(place.stop, 8000);
            endPet({ ...petImage, result: 'done', message: '', picture: {
                    blob: result.blob, width: result.parameters.width, height: result.parameters.height, target: place.target, veil: () => veil(place.stop),
                } });
            try {
                await save;
                const saved = historyKey ? `已保存 ${history.length} 张图片 · 点击查看历史` : '图片仅保留在当前页面，可下载保存。';
                report(saved);
                emitPetEvent({ type: 'history', id: pet, saved: true, pageOnly: !historyKey, message: saved });
            }
            catch (error) {
                const failed = `图片已生成，但历史未保存：${error instanceof Error ? error.message : '浏览器存储不可用。'}`;
                report(failed);
                emitPetEvent({ type: 'history', id: pet, saved: false, message: failed });
            }
            finally {
                saves.delete(item.id);
            }
        }
        catch (error) {
            if (controller.signal.aborted) {
                endPet({ ...petImage, result: 'dropped', serverMayContinue: phase !== 'queued', message: '' });
                return;
            }
            const cancelled = job.signal.aborted;
            report(cancelled ? '已取消本次等待，服务端任务可能仍在继续。' : error instanceof Error ? error.message : '生图未完成，请稍后重试。');
            endPet({ ...petImage, result: cancelled ? 'cancelled' : 'failed', message: status,
                fault: cancelled ? undefined : petFault(error), serverMayContinue: cancelled && phase !== 'queued' });
        }
        finally {
            endPet({ ...petImage, result: 'dropped', message: '' });
            controller.signal.removeEventListener('abort', cancel);
            autoSignal?.removeEventListener('abort', cancel);
            request = null;
            phase = 'idle';
            show();
        }
    }
    return {
        generate,
        async generateAutomatically(signal) {
            await ready;
            if (signal.aborted || !historyAvailable || history.length || request)
                return;
            await generate(signal);
        },
        cancel() { request?.abort(); },
        open() { if (history.length)
            gallery.open(); },
        removeHistory: remove,
        refresh: show,
        dispose() {
            controller.abort();
            gallery.close();
            gallery.element.remove();
            history.forEach(item => URL.revokeObjectURL(item.url));
            history = [];
        },
    };
}
