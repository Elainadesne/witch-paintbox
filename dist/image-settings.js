import { createSettingsStorage } from './host-settings.js';
import { defaultOpenAIImageParameters, validateOpenAIImageParameters } from './openai-image.js';
import { withFault } from './pet-events.js';
export const IMAGE_PROVIDERS = ['novelai', 'openai'];
import { defaultImageParameters, NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULES, } from './novelai.js';
const storageKey = 'witch-paintbox:image-settings:v1';
export function defaultImageSettings(provider = 'novelai') {
    return {
        provider, openaiParameters: defaultOpenAIImageParameters(), models: [],
        connection: { channel: 'official', url: '', key: '' },
        connectionProfiles: [],
        activeConnectionId: '',
        parameters: defaultImageParameters(),
        positive: '',
        negative: '',
        artists: [],
        activeArtistId: '',
    };
}
function invalid() {
    throw withFault(new Error('生图配置格式无效，请检查参数和配置条目。'), 'setup');
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    return value;
}
function text(value, maxLength = 65_536, required = false) {
    if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim()))
        invalid();
    return value;
}
function number(value, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        invalid();
    if (integer && !Number.isInteger(value))
        invalid();
    return value;
}
function boolean(value) {
    if (typeof value !== 'boolean')
        invalid();
    return value;
}
function option(value, options) {
    const selected = text(value, 128, true);
    if (!options.some(item => item.value === selected))
        invalid();
    return selected;
}
function connection(value) {
    const source = record(value);
    if (source.channel !== 'official' && source.channel !== 'custom')
        invalid();
    return { channel: source.channel, url: text(source.url, 8192), key: text(source.key, 16_384) };
}
function parameters(value) {
    const source = record(value);
    const width = number(source.width, 64, 4096, true);
    const height = number(source.height, 64, 4096, true);
    if (width % 64 || height % 64)
        invalid();
    return {
        model: option(source.model, NAI_MODELS),
        width,
        height,
        steps: number(source.steps, 1, 50, true),
        scale: number(source.scale, 0, 100),
        sampler: option(source.sampler, NAI_SAMPLERS),
        seed: number(source.seed, -1, 4_294_967_295, true),
        noiseSchedule: option(source.noiseSchedule, NAI_SCHEDULES),
        cfgRescale: number(source.cfgRescale, 0, 1),
        sm: boolean(source.sm),
        smDyn: boolean(source.smDyn),
    };
}
function profiles(value, parse) {
    if (!Array.isArray(value) || value.length > 200)
        invalid();
    const items = value.map(parse);
    if (new Set(items.map(item => item.id)).size !== items.length)
        invalid();
    return items;
}
function selectedId(value, items) {
    const id = text(value, 128);
    if (id && !items.some(item => item.id === id))
        invalid();
    return id;
}
export function validateImageSettings(value) {
    const source = record(value);
    const provider = source.provider ?? 'novelai';
    if (provider !== 'novelai' && provider !== 'openai')
        invalid();
    const models = source.models ?? [];
    if (!Array.isArray(models) || models.length > 10_000)
        invalid();
    const modelNames = models.map(value => text(value, 512, true));
    if (new Set(modelNames).size !== modelNames.length)
        invalid();
    const connectionProfiles = profiles(source.connectionProfiles, value => {
        const item = record(value);
        return { ...connection(item), id: text(item.id, 128, true), name: text(item.name, 128, true) };
    });
    const artists = profiles(source.artists, value => {
        const item = record(value);
        return {
            id: text(item.id, 128, true),
            name: text(item.name, 128, true),
            positive: text(item.positive),
            negative: text(item.negative),
        };
    });
    if (provider === 'openai' && (text(source.negative).trim() || artists.some(item => item.negative.trim()))) {
        throw new Error('GPT 配置不支持独立负面提示词，请先在来源配置中移除负面字段内容，再导入 GPT 配置。');
    }
    return {
        provider, models: modelNames,
        openaiParameters: validateOpenAIImageParameters(source.openaiParameters ?? defaultOpenAIImageParameters()),
        connection: connection(source.connection),
        connectionProfiles,
        activeConnectionId: selectedId(source.activeConnectionId, connectionProfiles),
        parameters: parameters(source.parameters),
        positive: text(source.positive),
        negative: text(source.negative),
        artists,
        activeArtistId: selectedId(source.activeArtistId, artists),
    };
}
function sameConnection(left, right) {
    return left.channel === right.channel && left.url === right.url;
}
export function defaultAllImageSettings() {
    return { version: 2, activeProvider: 'novelai', profiles: {
            novelai: defaultImageSettings('novelai'), openai: defaultImageSettings('openai'),
        } };
}
export function validateAllImageSettings(value) {
    const source = record(value);
    if (source.version === undefined) {
        const legacy = validateImageSettings(source);
        const all = defaultAllImageSettings();
        all.profiles[legacy.provider] = legacy;
        all.activeProvider = legacy.provider;
        return all;
    }
    if (source.version !== 2 || !IMAGE_PROVIDERS.includes(source.activeProvider))
        invalid();
    const profiles = record(source.profiles);
    const novelai = validateImageSettings(profiles.novelai);
    const openai = validateImageSettings(profiles.openai);
    if (novelai.provider !== 'novelai' || openai.provider !== 'openai')
        invalid();
    return { version: 2, activeProvider: source.activeProvider, profiles: { novelai, openai } };
}
const settingsStorage = createSettingsStorage({
    localKey: storageKey, hostKey: 'image-settings-v1', label: '生图配置',
    defaults: defaultAllImageSettings, validate: validateAllImageSettings,
    stripKeys(value) {
        for (const settings of Object.values(value.profiles)) {
            settings.connection.key = '';
            settings.connectionProfiles.forEach(profile => { profile.key = ''; });
        }
        return value;
    },
    restoreKeys(value, local) {
        for (const provider of IMAGE_PROVIDERS) {
            const settings = value.profiles[provider], savedSettings = local.profiles[provider];
            const active = savedSettings.connectionProfiles.find(item => item.id === settings.activeConnectionId && sameConnection(item, settings.connection));
            settings.connection.key = active?.key ?? (settings.activeConnectionId === savedSettings.activeConnectionId
                && sameConnection(settings.connection, savedSettings.connection) ? savedSettings.connection.key : '');
            for (const profile of settings.connectionProfiles) {
                const saved = savedSettings.connectionProfiles.find(item => item.id === profile.id && sameConnection(item, profile));
                profile.key = saved?.key ?? '';
            }
        }
        return value;
    },
    changed() { window.dispatchEvent(new Event('witch-paintbox:image-settings-changed')); },
});
export function loadAllImageSettings() { return settingsStorage.load(); }
export function loadImageSettings(provider) {
    const all = settingsStorage.load();
    return all.profiles[provider ?? all.activeProvider];
}
export function saveImageSettings(settings) {
    const snapshot = validateImageSettings(settings);
    return settingsStorage.update(all => ({ ...all, profiles: { ...all.profiles, [snapshot.provider]: snapshot } }));
}
export async function switchImageProvider(provider) {
    if (!IMAGE_PROVIDERS.includes(provider))
        invalid();
    if (settingsStorage.load().activeProvider === provider)
        return;
    await settingsStorage.update(all => ({ ...all, activeProvider: provider }));
    window.dispatchEvent(new Event('witch-paintbox:image-provider-changed'));
}
/** Bulk import refreshes the UI only after every section commits or rolls back. */
export function saveAllImageSettings(settings) {
    return settingsStorage.save(settings);
}
