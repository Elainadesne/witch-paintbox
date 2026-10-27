import type { ImageSettings } from './image-settings.js';
import { prepareImagePrompt, type CharacterPrompt, type PreparedImagePrompt } from './image-prompt.js';
import { resolveStoredAnchorPrompt } from './anchor-resolver.js';
import { generateImage, type ImageParameters } from './novelai.js';
import { generateOpenAIImage, type OpenAIImageParameters } from './openai-image.js';
import type { ImageGenerationProgress } from './image-queue.js';
import { withFault } from './pet-events.js';

interface ImageResult {
  blob: Blob;
  positive: string;
  negative: string;
  characters: CharacterPrompt[];
}

export type ConfiguredImageResult = ImageResult & (
  | { provider: 'novelai'; parameters: ImageParameters; seed: number }
  | { provider: 'openai'; parameters: OpenAIImageParameters; seed?: never }
);

/** Send already expanded fields without interpreting library text as source-protocol syntax. */
export async function generatePreparedImage(
  settings: ImageSettings,
  prompt: PreparedImagePrompt,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<ConfiguredImageResult> {
  signal.throwIfAborted();
  const connection = { ...settings.connection };
  if (settings.provider === 'openai') {
    const parameters = { ...settings.openaiParameters };
    if (prompt.negative.trim()) throw withFault(new Error('GPT 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。'), 'setup');
    if (prompt.characters.length) throw withFault(new Error('GPT 生图接口不支持 NAI 角色分栏，请使用普通正面提示词。'), 'setup');
    const positive = prompt.positive;
    const result = await generateOpenAIImage(connection, parameters, positive, signal, onProgress);
    return { ...result, provider: 'openai', positive, negative: '', characters: [] };
  }
  if (settings.provider && settings.provider !== 'novelai') throw withFault(new Error('当前生图服务类型不受支持。'), 'setup');
  const parameters = { ...settings.parameters };
  const prepared = { positive: prompt.positive, negative: prompt.negative, characters: prompt.characters.map(character => ({ ...character })) };
  const result = await generateImage(connection, parameters, prepared.positive, prepared.negative, signal,
    progress => onProgress?.({ ...progress, columns: prepared.characters.length }), prepared.characters);
  return { ...result, provider: 'novelai', parameters: { ...parameters, seed: result.seed }, ...prepared };
}

/** Freeze each click before asynchronous anchor loading and the shared request queue. */
export async function generateConfiguredImage(
  settings: ImageSettings,
  scene: string,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
  artistPositive = '',
): Promise<ConfiguredImageResult> {
  signal.throwIfAborted();
  const snapshot = { ...settings, connection: { ...settings.connection },
    parameters: { ...settings.parameters }, openaiParameters: { ...settings.openaiParameters } };
  let prompt: PreparedImagePrompt;
  if (snapshot.provider === 'openai') {
    if (snapshot.negative.trim()) throw withFault(new Error('GPT 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。'), 'setup');
    // No NAI column parsing, weight conversion, or hidden instructions are added to a GPT prompt.
    const expanded = await resolveStoredAnchorPrompt(scene);
    prompt = { positive: [expanded, artistPositive].filter(value => value.trim()).join(', '), negative: '', characters: [] };
  } else {
    const model = snapshot.parameters.model;
    const characterLimit = model === 'nai-diffusion-3' ? 0 : model.startsWith('nai-diffusion-5') ? 22 : 6;
    prompt = await prepareImagePrompt(scene, snapshot.negative, artistPositive, characterLimit);
  }
  return generatePreparedImage(snapshot, prompt, signal, onProgress);
}
