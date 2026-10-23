import type { ModelMessage } from './model-types.js';
import type { ModelSettings } from './model-settings.js';
import { stripImageBlocks } from './context-filter.js';

export interface FeatureContext {
  messages: readonly ModelMessage[];
  data?: unknown;
  signal?: AbortSignal;
  settings?: Readonly<ModelSettings>;
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

export async function featureLayerMessages(id: string, settings: ModelSettings, context: FeatureContext): Promise<ModelMessage[]> {
  const layer = layers.get(id);
  if (!layer) throw new Error('功能层当前不可用，请关闭此条目或重新加载对应功能。');
  context.signal?.throwIfAborted();
  const messages = await layer.messages({ ...context, settings, messages: copyMessages(context.messages) });
  context.signal?.throwIfAborted();
  return copyMessages(messages);
}

/** Follow the visible entry order. Provider data is read afresh; no automatic instructions. */
export async function buildModelMessages(settings: ModelSettings, context: FeatureContext): Promise<ModelMessage[]> {
  settings = structuredClone(settings);
  context.signal?.throwIfAborted();
  const input = copyMessages(context.messages).map(message => ({ ...message,
    content: settings.hideImageContext ? stripImageBlocks(message.content) : message.content,
  }));
  const entries = new Map([...settings.head, ...settings.tail].map(entry => [`prompt:${entry.id}`, entry]));
  const output: ModelMessage[] = [];
  for (const key of settings.promptOrder) {
    if (key === 'input') output.push(...copyMessages(input));
    else if (key.startsWith('layer:')) {
      const id = key.slice(6);
      if (settings.enabledLayers.includes(id)) output.push(...await featureLayerMessages(id, settings, { ...context, messages: input }));
    } else {
      const entry = entries.get(key);
      if (!entry) throw new Error('预设排序引用了不存在的条目，请重新保存预设。');
      if (entry.enabled && !entry.marker && entry.content.trim()) output.push(...copyMessages([entry]));
    }
  }
  if (!output.some(message => message.content.trim())) throw new Error('当前没有可发送的内容。');
  return output;
}
