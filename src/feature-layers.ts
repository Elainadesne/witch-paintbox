import type { ModelMessage } from './model-types.js';
import type { ModelSettings, PromptEntry } from './model-settings.js';

export interface FeatureContext {
  messages: readonly ModelMessage[];
  data?: unknown;
  signal?: AbortSignal;
}

export interface FeatureLayer {
  id: string;
  title: string;
  messages(context: FeatureContext): readonly ModelMessage[] | Promise<readonly ModelMessage[]>;
}

const layers = new Map<string, FeatureLayer>();
const changes = new EventTarget();

/** Register a future worldbook or other feature provider. Registration does not enable or send it. */
export function registerFeatureLayer(layer: FeatureLayer): () => void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(layer.id) || !layer.title.trim() || layer.title.length > 128
    || typeof layer.messages !== 'function') throw new Error('功能层接口定义无效。');
  if (layers.has(layer.id)) throw new Error('功能层标识已注册。');
  const registered = { ...layer };
  layers.set(layer.id, registered);
  changes.dispatchEvent(new Event('change'));
  return () => {
    if (layers.get(registered.id) !== registered) return;
    layers.delete(registered.id);
    changes.dispatchEvent(new Event('change'));
  };
}

export function listFeatureLayers(): { id: string; title: string }[] {
  return Array.from(layers.values(), ({ id, title }) => ({ id, title }));
}

export function onFeatureLayersChanged(callback: () => void): () => void {
  changes.addEventListener('change', callback);
  return () => changes.removeEventListener('change', callback);
}

function copyMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  if (!Array.isArray(messages) || messages.length > 500) throw new Error('功能层返回的消息数量无效。');
  return messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || message.content.length > 1_048_576) {
      throw new Error('功能层返回的消息格式无效。');
    }
    return { role: message.role, content: message.content };
  });
}

function presetMessages(entries: PromptEntry[]): ModelMessage[] {
  return copyMessages(entries.filter(entry => entry.enabled && entry.content.trim()));
}

/** Exact order: preset head → enabled providers → caller input → preset tail. No automatic prompts. */
export async function buildModelMessages(settings: ModelSettings, context: FeatureContext): Promise<ModelMessage[]> {
  context.signal?.throwIfAborted();
  const input = copyMessages(context.messages);
  const output = presetMessages(settings.head);
  for (const id of settings.enabledLayers) {
    const layer = layers.get(id);
    if (!layer) throw new Error('已启用的功能层当前不可用，请在功能层配置中关闭它或重新加载对应功能。');
    const messages = await layer.messages({ ...context, messages: copyMessages(input) });
    context.signal?.throwIfAborted();
    output.push(...copyMessages(messages));
  }
  output.push(...input, ...presetMessages(settings.tail));
  if (!output.some(message => message.content.trim())) throw new Error('当前没有可发送的内容。');
  return output;
}
