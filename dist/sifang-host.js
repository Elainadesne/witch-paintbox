// The host getter binds ownership from the plugin's module stack. Read it once,
// before callbacks run, and never resolve it through a hidden chat mirror.
const nativeEnvironment = 'Sifang' in globalThis;
export const sifangHost = globalThis.Sifang;
export function isSifangEnvironment() { return nativeEnvironment; }
/** Request the browser viewport before mounting fixed-position UI in the native room. */
export async function bindSifangWindowViewport(signal) {
    const host = sifangHost;
    if (signal.aborted || !host?.capabilities.includes('native-window-viewport') || !host.ui.windowViewport)
        return;
    const setViewport = host.ui.windowViewport.bind(host.ui);
    await setViewport(true);
    const release = () => { void setViewport(false).catch(() => { }); };
    if (signal.aborted)
        release();
    else
        signal.addEventListener('abort', release, { once: true });
}
export function requireSifangHost() {
    const host = sifangHost;
    if (!host || host.apiVersion !== 1
        || !['native-game', 'native-events', 'native-text-write', 'native-image-markers'].every(name => host.capabilities?.includes(name))
        || typeof host.game?.floor !== 'function' || typeof host.game.floors !== 'function'
        || typeof host.game.save !== 'function' || typeof host.game.replaceText !== 'function'
        || typeof host.ui?.imageMarkers !== 'function' || typeof host.ui.imageMarker !== 'function'
        || typeof host.on !== 'function') {
        throw new Error('独立前端与魔女画匣的接口版本不匹配，请更新支持正文写回和原位配图的独立前端。');
    }
    return host;
}
