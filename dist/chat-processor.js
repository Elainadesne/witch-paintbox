import { captureLatestAssistant, replaceAssistantMessage } from './chat-host.js';
import { applyImageInsertions, createImageInsertionPlan } from './image-insertion.js';
import { loadModelSettings } from './model-settings.js';
import { runConfiguredModel } from './model-service.js';
import { emitPetEvent, petFault, petTaskId, withFault } from './pet-events.js';
import { imageSizeMode } from './image-size-mode.js';
export class ChatProcessor {
    report;
    request = null;
    committing = false;
    constructor(report) {
        this.report = report;
    }
    cancel() { if (!this.committing)
        this.request?.abort(); }
    async process() {
        if (this.request)
            return;
        const controller = new AbortController();
        this.request = controller;
        const pet = petTaskId();
        let floor;
        this.report('正在读取最新回复…', true);
        emitPetEvent({ type: 'process', id: pet, phase: 'reading', cancellable: true });
        try {
            const settings = loadModelSettings();
            if (!settings.parseImageMarkers)
                throw withFault(new Error('请先在模型 API 预设区开启“解析配图标记”。'), 'setup');
            if (![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
                throw withFault(new Error('请先导入或填写处理正文的预设，并保存配置。'), 'setup');
            }
            const snapshot = await captureLatestAssistant();
            const plan = createImageInsertionPlan(snapshot.text);
            if (!plan.points.length)
                throw withFault(new Error('当前正文没有可用的行间插入点。'), 'format');
            controller.signal.throwIfAborted();
            this.report(`正在处理第 ${snapshot.messageId + 1} 楼…`, true);
            floor = snapshot.messageId;
            emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, cancellable: true });
            const candidate = await runConfiguredModel({
                messages: [{ role: 'user', content: plan.text }], sourceText: snapshot.text, signal: controller.signal,
            }, text => {
                this.report(`AI 处理中 · 已返回 ${text.length} 字符`, true);
                emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, chars: text.length, cancellable: true });
            }, settings);
            controller.signal.throwIfAborted();
            const result = applyImageInsertions(plan, candidate);
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
        }
        catch (error) {
            const aborted = controller.signal.aborted;
            const message = aborted ? '已取消 AI 处理。' : error.message;
            this.report(message, false, !aborted);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: aborted ? 'cancelled' : 'failed', floor, message,
                fault: aborted ? undefined : petFault(error) });
        }
        finally {
            this.committing = false;
            if (this.request === controller)
                this.request = null;
        }
    }
}
