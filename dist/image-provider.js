import { prepareImagePrompt } from './image-prompt.js';
import { resolveStoredAnchorPromptFields } from './anchor-resolver.js';
import { generateImage } from './novelai.js';
import { generateOpenAIImage } from './openai-image.js';
import { withFault } from './pet-events.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { imageSizeMode } from './image-size-mode.js';
import { imageSizeDimensions } from './image-size.js';
/** Resolve one marker before queuing; never overwrite the user's fallback dimensions. */
export function imageSettingsForMarker(settings, marker) {
    if (isImageSizeModeSaving())
        throw withFault(new Error('画幅模式正在同步，请完成后再生成图片。'), 'setup');
    if (!marker.size || imageSizeMode(loadModelSettings(settings.provider)) !== 'ai')
        return settings;
    const dimensions = imageSizeDimensions(marker.size);
    return settings.provider === 'openai'
        ? { ...settings, openaiParameters: { ...settings.openaiParameters, ...dimensions } }
        : { ...settings, parameters: { ...settings.parameters, ...dimensions } };
}
/** Send already expanded fields without interpreting library text as source-protocol syntax. */
export async function generatePreparedImage(settings, prompt, signal, onProgress) {
    signal.throwIfAborted();
    const connection = { ...settings.connection };
    if (settings.provider === 'openai') {
        const parameters = { ...settings.openaiParameters };
        if (prompt.negative.trim())
            throw withFault(new Error('GPT 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。'), 'setup');
        if (prompt.characters.length)
            throw withFault(new Error('GPT 生图接口不支持 NAI 角色分栏，请使用普通正面提示词。'), 'setup');
        const positive = prompt.positive;
        const result = await generateOpenAIImage(connection, parameters, positive, signal, onProgress);
        return { ...result, provider: 'openai', positive, negative: '', characters: [] };
    }
    if (settings.provider && settings.provider !== 'novelai')
        throw withFault(new Error('当前生图服务类型不受支持。'), 'setup');
    const parameters = { ...settings.parameters };
    const prepared = { positive: prompt.positive, negative: prompt.negative, characters: prompt.characters.map(character => ({ ...character })) };
    const result = await generateImage(connection, parameters, prepared.positive, prepared.negative, signal, progress => onProgress?.({ ...progress, columns: prepared.characters.length }), prepared.characters);
    return { ...result, provider: 'novelai', parameters: { ...parameters, seed: result.seed }, ...prepared };
}
/** Freeze each click before asynchronous anchor loading and the shared request queue. */
export async function generateConfiguredImage(settings, scene, signal, onProgress, artistPositive = '') {
    signal.throwIfAborted();
    const snapshot = { ...settings, connection: { ...settings.connection },
        parameters: { ...settings.parameters }, openaiParameters: { ...settings.openaiParameters } };
    let prompt;
    if (snapshot.provider === 'openai') {
        if (snapshot.negative.trim())
            throw withFault(new Error('GPT 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。'), 'setup');
        // No NAI column parsing, weight conversion, or hidden instructions are added to a GPT prompt.
        const expanded = await resolveStoredAnchorPromptFields(scene);
        if (expanded.negative.trim()) {
            throw withFault(new Error('GPT 生图不支持角色独立负面提示词，请清空该角色的负面词或切换 NAI。'), 'setup');
        }
        prompt = { positive: [expanded.positive, artistPositive].filter(value => value.trim()).join(', '), negative: '', characters: [] };
    }
    else {
        const model = snapshot.parameters.model;
        const characterLimit = model === 'nai-diffusion-3' ? 0 : model.startsWith('nai-diffusion-5') ? 22 : 6;
        prompt = await prepareImagePrompt(scene, snapshot.negative, artistPositive, characterLimit);
    }
    return generatePreparedImage(snapshot, prompt, signal, onProgress);
}
