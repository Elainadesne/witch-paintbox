import { captureLatestAssistant, replaceAssistantMessage } from './chat-host.js';
import { applyImageInsertions, createImageInsertionPlan } from './image-insertion.js';
import { loadModelSettings } from './model-settings.js';
import { runConfiguredModel } from './model-service.js';
import { withFault } from './pet-events.js';

export class ChatProcessor {
  private request: AbortController | null = null;
  private committing = false;
  constructor(private report: (message: string, busy: boolean, error?: boolean, cancellable?: boolean) => void) {}

  cancel(): void { if (!this.committing) this.request?.abort(); }

  async process(): Promise<void> {
    if (this.request) return;
    const controller = new AbortController();
    this.request = controller;
    this.report('正在读取最新回复…', true);
    try {
      const settings = loadModelSettings();
      if (!settings.parseImageMarkers) throw withFault(new Error('请先在模型 API 预设区开启“解析配图标记”。'), 'setup');
      if (![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
        throw withFault(new Error('请先导入或填写处理正文的预设，并保存配置。'), 'setup');
      }
      const snapshot = await captureLatestAssistant();
      const plan = createImageInsertionPlan(snapshot.text);
      if (!plan.points.length) throw withFault(new Error('当前正文没有可用的行间插入点。'), 'format');
      controller.signal.throwIfAborted();
      this.report(`正在处理第 ${snapshot.messageId + 1} 楼…`, true);
      const candidate = await runConfiguredModel({
        messages: [{ role: 'user', content: plan.text }], sourceText: snapshot.text, signal: controller.signal,
      }, text => this.report(`AI 处理中 · 已返回 ${text.length} 字符`, true), settings);
      controller.signal.throwIfAborted();
      const result = applyImageInsertions(plan, candidate);
      if (!result.added.length) throw withFault(new Error('AI 未返回配图数据，原文未变。'), 'format');
      this.committing = true;
      this.report('正在按插入点保存配图标记…', true, false, false);
      await replaceAssistantMessage(snapshot, result, controller.signal);
      this.report(`已保存 ${result.added.length} 处配图标记，原正文与 HTML 前端已保留。`, false);
    } catch (error) {
      this.report(controller.signal.aborted ? '已取消 AI 处理。' : (error as Error).message, false, !controller.signal.aborted);
    } finally {
      this.committing = false;
      if (this.request === controller) this.request = null;
    }
  }
}
