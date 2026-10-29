import type { ImageSettings } from './image-settings.js';
import { prepareImagePrompt, type CharacterPrompt, type PreparedImagePrompt } from './image-prompt.js';
import { resolveStoredAnchorPromptFields } from './anchor-resolver.js';
import { generateImage, type ImageParameters } from './novelai.js';
import { generateOpenAIImage, type OpenAIImageParameters } from './openai-image.js';
import { generateGeminiImage } from './gemini-image.js';
import { generateGrokImage } from './grok-image.js';
import { geminiExpectedSize, grokExpectedSize, geminiRatioForSize, grokRatioForSize, type GeminiImageParameters, type GrokImageParameters } from './aspect-image.js';
import { imageProviderName, isNaturalLanguageProvider } from './image-settings.js';
import type { ImageGenerationProgress } from './image-queue.js';
import { withFault } from './pet-events.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { imageSizeMode } from './image-size-mode.js';
import { imageSizeDimensions } from './image-size.js';
import type { ImageMarker } from './image-markers.js';

/** Resolve one marker before queuing; never overwrite the user's fallback dimensions. */
export function imageSettingsForMarker(settings: ImageSettings, marker: Pick<ImageMarker, 'size'>): ImageSettings {
  if (isImageSizeModeSaving()) throw withFault(new Error('画幅模式正在同步，请完成后再生成图片。'), 'setup');
  if (!marker.size || imageSizeMode(loadModelSettings(settings.provider)) !== 'ai') return settings;
  if (settings.provider === 'gemini') {
    return { ...settings, geminiParameters: { ...settings.geminiParameters, aspectRatio: geminiRatioForSize(marker.size) } };
  }
  if (settings.provider === 'grok') {
    return { ...settings, grokParameters: { ...settings.grokParameters, aspectRatio: grokRatioForSize(marker.size) } };
  }
  const dimensions = imageSizeDimensions(marker.size);
  return settings.provider === 'openai'
    ? { ...settings, openaiParameters: { ...settings.openaiParameters, ...dimensions } }
    : { ...settings, parameters: { ...settings.parameters, ...dimensions } };
}

interface ImageResult {
  blob: Blob;
  positive: string;
  negative: string;
  characters: CharacterPrompt[];
}

export type ConfiguredImageResult = ImageResult & (
  | { provider: 'novelai'; parameters: ImageParameters; seed: number }
  | { provider: 'openai'; parameters: OpenAIImageParameters; seed?: never }
  | { provider: 'gemini'; parameters: GeminiImageParameters & { width: number; height: number }; seed?: never }
  | { provider: 'grok'; parameters: GrokImageParameters & { width: number; height: number }; seed?: never }
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
  if (settings.provider === 'gemini' || settings.provider === 'grok') {
    const name = imageProviderName(settings.provider);
    if (prompt.negative.trim()) throw withFault(new Error(`${name} 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。`), 'setup');
    if (prompt.characters.length) throw withFault(new Error(`${name} 生图接口不支持 NAI 角色分栏，请使用普通正面提示词。`), 'setup');
    const positive = prompt.positive;
    if (settings.provider === 'gemini') {
      const result = await generateGeminiImage(connection, { ...settings.geminiParameters }, positive, signal, onProgress);
      return { blob: result.blob, provider: 'gemini', parameters: { ...result.parameters, width: result.width, height: result.height }, positive, negative: '', characters: [] };
    }
    const result = await generateGrokImage(connection, { ...settings.grokParameters }, positive, signal, onProgress);
    return { blob: result.blob, provider: 'grok', parameters: { ...result.parameters, width: result.width, height: result.height }, positive, negative: '', characters: [] };
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
    parameters: { ...settings.parameters }, openaiParameters: { ...settings.openaiParameters },
    geminiParameters: { ...settings.geminiParameters }, grokParameters: { ...settings.grokParameters } };
  let prompt: PreparedImagePrompt;
  if (isNaturalLanguageProvider(snapshot.provider)) {
    const name = imageProviderName(snapshot.provider);
    if (snapshot.negative.trim()) throw withFault(new Error(`${name} 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。`), 'setup');
    // No NAI column parsing, weight conversion, or hidden instructions are added to a natural-language prompt.
    const expanded = await resolveStoredAnchorPromptFields(scene);
    if (expanded.negative.trim()) {
      throw withFault(new Error(`${name} 生图不支持角色独立负面提示词，请清空该角色的负面词或切换 NAI。`), 'setup');
    }
    prompt = { positive: [expanded.positive, artistPositive].filter(value => value.trim()).join(', '), negative: '', characters: [] };
  } else {
    const model = snapshot.parameters.model;
    const characterLimit = model === 'nai-diffusion-3' ? 0 : model.startsWith('nai-diffusion-5') ? 22 : 6;
    prompt = await prepareImagePrompt(scene, snapshot.negative, artistPositive, characterLimit);
  }
  return generatePreparedImage(snapshot, prompt, signal, onProgress);
}

/** Expected canvas for placeholders and pet events; Gemini / Grok are estimated from ratio and tier. */
export function expectedImageSize(settings: ImageSettings): { width: number; height: number } {
  if (settings.provider === 'gemini') {
    const p = settings.geminiParameters;
    return geminiExpectedSize(p.model, p.aspectRatio, p.imageSize);
  }
  if (settings.provider === 'grok') return grokExpectedSize(settings.grokParameters.aspectRatio, settings.grokParameters.resolution);
  const { width, height } = settings.provider === 'openai' ? settings.openaiParameters : settings.parameters;
  return { width, height };
}
