import { requestModel } from './model-api.js';
import { buildModelMessages, type FeatureContext } from './feature-layers.js';
import { loadModelSettings } from './model-settings.js';

/** Called explicitly by a feature; opening configuration pages never generates anything. */
export async function runConfiguredModel(context: FeatureContext, onText?: (text: string) => void): Promise<string> {
  const settings = loadModelSettings();
  const messages = await buildModelMessages(settings, context);
  return requestModel(settings, messages, { signal: context.signal, onText });
}
