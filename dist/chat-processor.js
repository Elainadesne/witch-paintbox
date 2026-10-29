import { assertChatSnapshot, captureLatestAssistant, replaceAssistantMessage } from './chat-host.js';
import { applyImageInsertions, createImageInsertionPlan, createSelectedImageInsertionPlan, selectImageInsertionPoints } from './image-insertion.js';
import { normalizeIllustrationItems } from './illustration-selection.js';
import { MAX_IMAGE_MARKERS, parseImageMarkers } from './image-markers.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { runConfiguredModel } from './model-service.js';
import { emitPetEvent, petFault, petTaskId, withFault } from './pet-events.js';
import { imageSizeMode } from './image-size-mode.js';
function processingSettings() {
    if (isImageSizeModeSaving())
        throw withFault(new Error('画幅模式正在同步，请完成后再开始 AI 生图。'), 'setup');
    const settings = loadModelSettings();
    if (!settings.parseImageMarkers)
        throw withFault(new Error('请先在模型 API 预设区开启“解析配图标记”。'), 'setup');
    if (![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
        throw withFault(new Error('请先导入或填写处理正文的预设，并保存配置。'), 'setup');
    }
    return settings;
}
async function captureSelection(targeted = false) {
    const snapshot = await captureLatestAssistant();
    const plan = targeted ? createSelectedImageInsertionPlan(snapshot.text) : createImageInsertionPlan(snapshot.text);
    if (!plan.points.length)
        throw withFault(new Error('当前正文没有可用的行间插入点。'), 'format');
    const capacity = MAX_IMAGE_MARKERS - parseImageMarkers(snapshot.text).length;
    if (!capacity)
        throw withFault(new Error('当前楼层已有 64 处图片标记，请先移除部分标记。'), 'format');
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
            throw new Error('请先完成或取消当前 AI 处理。');
        processingSettings();
        const selection = await captureSelection(true);
        if (this.busy)
            throw new Error('请先完成或取消当前 AI 处理。');
        return selection;
    }
    async process(selection) {
        if (this.request)
            return false;
        const controller = new AbortController();
        this.request = controller;
        const pet = petTaskId();
        let floor;
        this.report('正在读取最新回复…', true);
        emitPetEvent({ type: 'process', id: pet, phase: 'reading', cancellable: true });
        try {
            const settings = processingSettings();
            const prepared = selection ?? await captureSelection();
            const { snapshot } = prepared;
            if (prepared.plan.original !== snapshot.text) {
                throw withFault(new Error('所选正文已变化，请重新打开指定插图。'), 'format');
            }
            const items = selection ? normalizeIllustrationItems(prepared.plan, selection.items) : undefined;
            const plan = items ? selectImageInsertionPoints(prepared.plan, items.flatMap(item => [...item.pointIds])) : prepared.plan;
            if (selection)
                await assertChatSnapshot(snapshot);
            controller.signal.throwIfAborted();
            this.report(`正在处理第 ${snapshot.messageId + 1} 楼…`, true);
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
                this.report(`AI 处理中 · 已返回 ${text.length} 字符`, true);
                emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, chars: text.length, cancellable: true });
            }, settings);
            controller.signal.throwIfAborted();
            const result = applyImageInsertions(plan, candidate, items);
            if (!result.added.length)
                throw withFault(new Error('AI 未返回配图数据，原文未变。'), 'format');
            this.committing = true;
            this.report('正在按插入点保存配图标记…', true, false, false);
            emitPetEvent({ type: 'process', id: pet, phase: 'saving', floor, cancellable: false });
            await replaceAssistantMessage(snapshot, result, controller.signal);
            const fallbackCount = imageSizeMode(settings) === 'ai' ? result.added.filter(marker => !marker.size).length : 0;
            const sizeNotice = fallbackCount ? `其中 ${fallbackCount} 处未提供有效尺寸，生图时使用设置中的画幅。` : result.warnings.join(' ');
            const message = `已保存 ${result.added.length} 处配图标记，原正文与 HTML 前端已保留。${sizeNotice}`;
            this.report(message, false);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: 'done', floor, added: result.added.length, message });
            return true;
        }
        catch (error) {
            const aborted = controller.signal.aborted;
            const message = aborted ? '已取消 AI 处理。' : error.message;
            this.report(message, false, !aborted);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: aborted ? 'cancelled' : 'failed', floor, message,
                fault: aborted ? undefined : petFault(error) });
            return false;
        }
        finally {
            this.committing = false;
            if (this.request === controller)
                this.request = null;
        }
    }
}
