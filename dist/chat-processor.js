import { assertChatSnapshot, captureLatestAssistant, replaceAssistantMessage } from './chat-host.js';
import { applyImageInsertions, createImageInsertionPlan, createSelectedImageInsertionPlan, selectImageInsertionPoints } from './image-insertion.js';
import { normalizeIllustrationItems } from './illustration-selection.js';
import { MAX_IMAGE_MARKERS, parseImageMarkers } from './image-markers.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { runConfiguredModel } from './model-service.js';
import { emitPetEvent, petFault, petTaskId, withFault } from './pet-events.js';
import { imageSizeMode } from './image-size-mode.js';
import { currentPreferences } from './settings.js';
function processingSettings() {
    if (isImageSizeModeSaving())
        throw withFault(new Error('画幅模式还在同步呢，等一秒再点 AI 生图。'), 'setup');
    const settings = loadModelSettings();
    if (!settings.parseImageMarkers)
        throw withFault(new Error('得先去“模型 API › 预设编排”下面打开“解析配图标记”。'), 'setup');
    if (![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
        throw withFault(new Error('先去导入或者自己写一套处理正文的预设再来吧。'), 'setup');
    }
    return settings;
}
async function captureSelection(targeted = false, expected) {
    const snapshot = expected ?? await captureLatestAssistant();
    const { excludedTags } = currentPreferences();
    const plan = targeted ? createSelectedImageInsertionPlan(snapshot.text, excludedTags) : createImageInsertionPlan(snapshot.text, excludedTags);
    if (!plan.points.length)
        throw withFault(new Error('这一楼正文里找不着能插图的行间空位。'), 'format');
    const capacity = MAX_IMAGE_MARKERS - parseImageMarkers(snapshot.text).length;
    if (!capacity)
        throw withFault(new Error('这一楼已经塞满 64 张配图了，先删几处再加吧。'), 'format');
    return Object.freeze({ snapshot, plan, capacity });
}
export class ChatProcessor {
    report;
    request = null;
    committing = false;
    constructor(report) {
        this.report = report;
    }
    get busy() { return this.request !== null; }
    cancel() { if (!this.committing)
        this.request?.abort(); }
    async prepareSelection() {
        if (this.busy)
            throw new Error('手头上一轮 AI 还在处理着呢，等它完事或者先取消再点。');
        processingSettings();
        const selection = await captureSelection(true);
        if (this.busy)
            throw new Error('手头上一轮 AI 还在处理着呢，等它完事或者先取消再点。');
        return selection;
    }
    async process(selection, options = {}) {
        if (this.request)
            return false;
        const controller = new AbortController();
        const cancel = () => { if (!this.committing)
            controller.abort(); };
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted)
            cancel();
        this.request = controller;
        const pet = petTaskId();
        let floor;
        this.report('正在拿最新一楼正文…', true);
        emitPetEvent({ type: 'process', id: pet, phase: 'reading', cancellable: true });
        try {
            const settings = processingSettings();
            controller.signal.throwIfAborted();
            const prepared = selection ?? await captureSelection(false, options.snapshot);
            const { snapshot } = prepared;
            if (prepared.plan.original !== snapshot.text) {
                throw withFault(new Error('你刚才圈出来的那段正文已经变了，重新打开“指定插图”再圈一遍吧。'), 'format');
            }
            const items = selection ? normalizeIllustrationItems(prepared.plan, selection.items) : undefined;
            const plan = items ? selectImageInsertionPoints(prepared.plan, items.flatMap(item => [...item.pointIds])) : prepared.plan;
            if (selection || options.snapshot)
                await assertChatSnapshot(snapshot);
            controller.signal.throwIfAborted();
            this.report(`正替第 ${snapshot.messageId + 1} 楼挑画面…`, true);
            floor = snapshot.messageId;
            emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, cancellable: true });
            const positions = items?.map(({ pointIds }, index) => pointIds.length === 1
                ? `【配图 ${index + 1}：在 ${pointIds[0]} 插入】`
                : `【配图 ${index + 1}：在 ${pointIds[0]} 到 ${pointIds[pointIds.length - 1]} 范围内插入；可用插入点：${pointIds.join(', ')}】`).join('\n');
            const input = items
                ? `${plan.text}\n\n<指定插图位置锁定>\n本次为人工指定插图位置模式：\n以下清单每项生成 1 张配图。单点项必须使用该编号；范围项必须从该范围列出的可用插入点中选择 1 个编号作为 at。严禁选择清单以外的位置，严禁遗漏或重复同一项。\n${positions}\n</指定插图位置锁定>`
                : plan.text;
            const candidate = await runConfiguredModel({
                messages: [{ role: 'user', content: input }], sourceText: snapshot.text, signal: controller.signal,
            }, text => {
                this.report(`AI 正在写提示词 · 已经吐了 ${text.length} 字`, true);
                emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, chars: text.length, cancellable: true });
            }, settings);
            controller.signal.throwIfAborted();
            const result = applyImageInsertions(plan, candidate, items);
            if (!result.added.length)
                throw withFault(new Error('AI 没给任何配图结果，楼层原文一点没动。'), 'format');
            this.committing = true;
            this.report('正照着插入点把配图标记嵌进楼层里…', true, false, false);
            emitPetEvent({ type: 'process', id: pet, phase: 'saving', floor, cancellable: false });
            await replaceAssistantMessage(snapshot, result, controller.signal);
            const fallbackCount = imageSizeMode(settings) === 'ai' ? result.added.filter(marker => !marker.size).length : 0;
            const sizeNotice = fallbackCount ? `（有 ${fallbackCount} 处没按要求给出尺寸，画的时候会用设置里的兜底画幅。）` : result.warnings.join(' ');
            const message = `已经插好 ${result.added.length} 处配图，原来的文字和前端样式都好好留着。${sizeNotice}`;
            this.report(message, false);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: 'done', floor, added: result.added.length, message });
            return true;
        }
        catch (error) {
            const aborted = controller.signal.aborted;
            const message = aborted ? '这次 AI 处理取消了。' : error.message;
            this.report(message, false, !aborted);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: aborted ? 'cancelled' : 'failed', floor, message,
                fault: aborted ? undefined : petFault(error) });
            return false;
        }
        finally {
            options.signal?.removeEventListener('abort', cancel);
            this.committing = false;
            if (this.request === controller)
                this.request = null;
        }
    }
}
