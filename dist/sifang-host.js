// The host getter binds ownership from the plugin's module stack. Read it once,
// before callbacks run, and never resolve it through a hidden chat mirror.
const nativeEnvironment = 'Sifang' in globalThis;
export const sifangHost = globalThis.Sifang;
export function isSifangEnvironment() { return nativeEnvironment; }
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
