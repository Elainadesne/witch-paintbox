import { captureLatestAssistant, replaceAssistantMessage } from './chat-host.js';
import { validateImageInsertions } from './image-markers.js';
import { loadModelSettings } from './model-settings.js';
import { runConfiguredModel } from './model-service.js';

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
      if (!settings.parseImageMarkers) throw new Error('请先在模型 API 预设区开启“解析配图标记”。');
      if (![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
        throw new Error('请先导入或填写处理正文的预设，并保存配置。');
      }
      const snapshot = await captureLatestAssistant();
      controller.signal.throwIfAborted();
      this.report(`正在处理第 ${snapshot.messageId + 1} 楼…`, true);
      const candidate = await runConfiguredModel({
        messages: [{ role: 'user', content: snapshot.text }], signal: controller.signal,
      }, text => this.report(`AI 处理中 · 已返回 ${text.length} 字符`, true), settings);
      controller.signal.throwIfAborted();
      const result = validateImageInsertions(snapshot.text, candidate);
      if (!result.added.length) throw new Error('AI 未插入新的有效配图标记，原文未变。');
      this.committing = true;
      this.report('正在核对楼层并保存…', true, false, false);
      await replaceAssistantMessage(snapshot, result.text, controller.signal);
      this.report(`已插入 ${result.added.length} 处配图标记，原正文保持不变。`, false);
    } catch (error) {
      this.report(controller.signal.aborted ? '已取消 AI 处理。' : (error as Error).message, false, !controller.signal.aborted);
    } finally {
      this.committing = false;
      if (this.request === controller) this.request = null;
    }
  }
}
