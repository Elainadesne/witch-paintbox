import { requestModel } from './model-api.js';
import { buildModelMessages, type FeatureContext } from './feature-layers.js';
import { loadModelSettings, type ModelSettings } from './model-settings.js';

/** Called explicitly by a feature; opening configuration pages never generates anything. */
export async function runConfiguredModel(context: FeatureContext, onText?: (text: string) => void, settings: ModelSettings = loadModelSettings()): Promise<string> {
  const messages = await buildModelMessages(settings, context);
  return requestModel(settings, messages, { signal: context.signal, onText });
}
