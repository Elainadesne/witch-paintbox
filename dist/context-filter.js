import { loadModelSettings } from './model-settings.js';
// A nested opener ends the candidate, so an unfinished block cannot consume the next scene.
const imageBlocks = /<img\s*>(?:(?!<\/?img\s*>)[\s\S])*<\/img\s*>/gi;
const ruleId = '394af125-b39e-4f3b-8798-86cef1b430d7';
export function stripImageBlocks(text) {
    return text.replace(imageBlocks, '');
}
let status = { enabled: true, active: false, error: '' };
const listeners = new Set();
let nativeEngine = null;
let binding = null;
let reportedError = '';
export function getContextFilterStatus() { return { ...status }; }
export function onContextFilterStatusChanged(callback) {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
}
function publish(next) {
    if (status.enabled === next.enabled && status.active === next.active && status.error === next.error)
        return;
    status = next;
    for (const listener of listeners) {
        try {
            listener(getContextFilterStatus());
        }
        catch { /* A settings view must not interrupt host generation. */ }
    }
    if (!next.error) {
        reportedError = '';
        return;
    }
    if (reportedError === next.error)
        return;
    reportedError = next.error;
    console.warn(`[魔女画匣] 图片上下文隐藏未生效：${next.error}`);
    const toast = globalThis.toastr;
    try {
        toast?.warning(next.error, '魔女画匣 · 图片上下文隐藏未生效');
    }
    catch { /* The settings page also shows this status. */ }
}
function host() {
    const root = globalThis;
    const context = root.SillyTavern?.getContext();
    if (!context?.extensionSettings || !context.eventTypes || typeof context.eventSource?.on !== 'function'
        || typeof context.eventSource.removeListener !== 'function') {
        throw new Error('当前酒馆未提供正则设置或生成事件接口，无法隐藏主 API 的图片上下文。');
    }
    return context;
}
function engine() {
    if (nativeEngine)
        return nativeEngine;
    const pending = import(new URL('/scripts/extensions/regex/engine.js', location.href).href).then(value => {
        const module = value;
        if (typeof module.getScriptsByType !== 'function' || typeof module.saveScriptsByType !== 'function'
            || typeof module.getRegexedString !== 'function' || !Number.isInteger(module.SCRIPT_TYPES?.GLOBAL)
            || !Number.isInteger(module.regex_placement?.USER_INPUT) || !Number.isInteger(module.regex_placement?.AI_OUTPUT)) {
            throw new Error();
        }
        return module;
    }).catch(() => {
        if (nativeEngine === pending)
            nativeEngine = null;
        throw new Error('无法加载酒馆原生正则接口，图片上下文隐藏尚未生效。请检查酒馆版本及正则扩展。');
    });
    nativeEngine = pending;
    return pending;
}
function isOwnRule(value) {
    return Boolean(value && typeof value === 'object' && value.id === ruleId);
}
/** Uses native promptOnly processing shared by chat- and text-completion backends. */
export function bindContextFilter(signal) {
    if (signal.aborted || (binding && !binding.aborted))
        return;
    binding = signal;
    let queue = Promise.resolve();
    const subscriptions = [];
    async function synchronize() {
        if (signal.aborted)
            return;
        let enabled = status.enabled;
        try {
            enabled = loadModelSettings().hideImageContext;
            const native = await engine();
            if (signal.aborted)
                return;
            // Settings may have changed while the native module was loading.
            enabled = loadModelSettings().hideImageContext;
            const context = host();
            if (enabled && !context.eventTypes.GENERATION_AFTER_COMMANDS && !context.eventTypes.GENERATION_STARTED) {
                throw new Error('当前酒馆缺少生成前事件，无法确认图片上下文隐藏会在主 API 请求前生效。');
            }
            if (enabled && (!Array.isArray(context.extensionSettings.disabledExtensions)
                || context.extensionSettings.disabledExtensions.includes('regex'))) {
                throw new Error('酒馆原生正则扩展未启用。请先启用正则扩展，再开启图片上下文隐藏。');
            }
            const scripts = native.getScriptsByType(native.SCRIPT_TYPES.GLOBAL);
            if (!Array.isArray(scripts))
                throw new Error('酒馆全局正则列表格式无效，原有规则未修改。');
            const rule = {
                id: ruleId, scriptName: '魔女画匣 · 图片标记仅从上下文隐藏',
                findRegex: imageBlocks.toString(), replaceString: '', trimStrings: [],
                placement: [native.regex_placement.USER_INPUT, native.regex_placement.AI_OUTPUT],
                disabled: !enabled, markdownOnly: false, promptOnly: true, runOnEdit: false,
                substituteRegex: 0, minDepth: null, maxDepth: null,
            };
            const own = scripts.filter(isOwnRule);
            const unchanged = own.length === 1 && scripts[0] === own[0]
                && Object.keys(rule).every(key => JSON.stringify(own[0][key]) === JSON.stringify(rule[key]));
            if (!unchanged) {
                // Preserve every other rule object and its relative order. Strip markers before another rule can rewrite them.
                await native.saveScriptsByType([rule, ...scripts.filter(item => !isOwnRule(item))], native.SCRIPT_TYPES.GLOBAL);
            }
            if (signal.aborted)
                return;
            publish({ enabled, active: enabled, error: '' });
        }
        catch (error) {
            if (signal.aborted)
                return;
            publish({ enabled, active: false, error: error instanceof Error ? error.message : '图片上下文隐藏未能接入酒馆。' });
        }
    }
    const schedule = () => {
        queue = queue.then(synchronize);
        return queue;
    };
    window.addEventListener('witch-paintbox:model-settings-changed', () => { void schedule(); }, { signal });
    window.addEventListener('storage', event => {
        if (event.key === null || event.key === 'witch-paintbox:model-settings:v1')
            void schedule();
    }, { signal });
    try {
        const context = host();
        const beforeGenerate = context.eventTypes.GENERATION_AFTER_COMMANDS ?? context.eventTypes.GENERATION_STARTED;
        const events = new Set([beforeGenerate, context.eventTypes.EXTENSION_SETTINGS_LOADED,
            context.eventTypes.SETTINGS_LOADED, context.eventTypes.SETTINGS_UPDATED].filter(Boolean));
        for (const event of events) {
            context.eventSource.on(event, schedule);
            subscriptions.push({ context, event });
        }
    }
    catch (error) {
        publish({ enabled: status.enabled, active: false, error: error instanceof Error ? error.message : '酒馆接口不可用。' });
    }
    signal.addEventListener('abort', () => {
        for (const { context, event } of subscriptions)
            context.eventSource.removeListener(event, schedule);
        if (binding === signal)
            binding = null;
    }, { once: true });
    void schedule();
}
