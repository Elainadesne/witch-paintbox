import type { ImageGenerationProgress } from './image-queue.js';
import type { ImageConnection } from './novelai.js';
import { fail, fetchOpenAIImageModels, postImagesGeneration, validateOpenAIImageConnection } from './openai-image.js';
import { ratioToOpenAISize, validateGrokImageParameters, type GrokImageParameters } from './aspect-image.js';

export const GROK_OFFICIAL_ENDPOINT = 'https://api.x.ai/v1/images/generations';

export function validateGrokConnection(connection: ImageConnection): ImageConnection {
  return validateOpenAIImageConnection(connection, GROK_OFFICIAL_ENDPOINT);
}

export function fetchGrokImageModels(connection: ImageConnection, signal: AbortSignal): Promise<string[]> {
  return fetchOpenAIImageModels(connection, signal, GROK_OFFICIAL_ENDPOINT);
}

/** xAI uses aspect_ratio + resolution; GPT-only `size` / `output_format` must never be sent natively. */
export function grokRequestBody(params: GrokImageParameters, prompt: string): Record<string, unknown> {
  if (params.protocol === 'openai') {
    return { model: params.model, prompt, n: 1, size: ratioToOpenAISize(params.aspectRatio), response_format: 'b64_json' };
  }
  const body: Record<string, unknown> = {
    model: params.model, prompt, n: 1, aspect_ratio: params.aspectRatio, resolution: params.resolution, response_format: 'b64_json',
  };
  // `quality` is documented only for grok-imagine-image-2.0; omit `auto` so older models are not rejected.
  if (params.quality !== 'auto') body.quality = params.quality;
  return body;
}

export async function generateGrokImage(
  connection: ImageConnection,
  parameters: GrokImageParameters,
  prompt: string,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<{ blob: Blob; parameters: GrokImageParameters; width: number; height: number }> {
  signal.throwIfAborted();
  const configured = validateGrokConnection(connection);
  const params = validateGrokImageParameters(parameters, () => fail('Grok 生图参数无效，请检查模型、比例和分辨率。', 'setup'));
  if (!params.model) fail('请先填写或拉取生图模型名称。', 'setup');
  if (typeof prompt !== 'string' || !prompt.trim()) fail('请填写正面提示词。', 'setup');
  const image = await postImagesGeneration(configured, grokRequestBody(params, prompt), signal, onProgress);
  return { blob: image.blob, parameters: params, width: image.width, height: image.height };
}
