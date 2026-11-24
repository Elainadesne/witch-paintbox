import { frameDocument, frontendFrames, visibleFrontendFrame } from './frontend-frames.js';
import { parseImageMarkers } from './image-markers.js';
import { withFault } from './pet-events.js';

type Turn = Record<string, unknown> & { message: string };
interface Game {
  isBackgroundProcessing?: boolean;
  isHistoryViewMode?: boolean;
  historyViewIndex?: number;
  chatHistoryCache?: Turn[];
  _getHistoryKey?(): string;
  _getCurrentViewSnapshot?(): { message?: string } | null;
}
interface Frontend {
  GameManagerInstance?: Game;
  LlmLock?: { blockedReason?(): string };
  AppStorage?: { saveData?(key: string, value: unknown, options?: { silent?: boolean }): Promise<unknown> };
}

function frontend(messageId: number) {
  const block = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
  if (!block) return null;
  const matches = frontendFrames(block).flatMap(frame => {
    if (!visibleFrontendFrame(frame) || !frameDocument(frame)) return [];
    try {
      const win = frame.contentWindow as (Window & Frontend) | null;
      return win?.GameManagerInstance ? [{ frame, win, game: win.GameManagerInstance }] : [];
    } catch { return []; }
  });
  if (matches.length > 1) throw withFault(new Error('这一楼挂了好几份前端回合缓存，分不清配图该往哪份写。'), 'host');
  return matches[0] ?? null;
}

function requireIdle(game: Game, win: Frontend): void {
  if (game.isBackgroundProcessing || win.LlmLock?.blockedReason?.()) {
    throw withFault(new Error('等这一楼的前端卡片把后台结算跑完，再点处理吧。'), 'host');
  }
  if (game.isHistoryViewMode) throw withFault(new Error('现在正在回看以前的回合呢，先切回最新那一回合再插图。'), 'host');
}

function historyKey(game: Game): string | null {
  const key = game._getHistoryKey?.();
  return typeof key === 'string' && key ? key : null;
}

const signatures = new WeakMap<Turn, { text: string; signature: string }>();
const runtimeIds = new WeakMap<Turn, number>();
let nextRuntimeId = 0;

function turnSignature(turn: Turn): string {
  const old = signatures.get(turn);
  if (old?.text === turn.message) return old.signature;
  // The unmodified narrative identifies a turn even after illustration blocks
  // are added. Duplicate narratives deliberately have no persistent history ID.
  let text = turn.message;
  for (const marker of parseImageMarkers(text).reverse()) text = text.slice(0, marker.start) + text.slice(marker.end);
  text = text.replace(/\s+/g, '');
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b);
  }
  const signature = `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
  signatures.set(turn, { text: turn.message, signature });
  return signature;
}

function cacheFor(game: Game): Turn[] {
  const cache = game.chatHistoryCache;
  if (!Array.isArray(cache) || !cache.length
    || cache.some(turn => !turn || typeof turn !== 'object' || typeof turn.message !== 'string')) {
    throw withFault(new Error('这一楼前端的回合缓存还没准备好。'), 'host');
  }
  return cache;
}

export function readEmbeddedTurn(messageId: number) {
  const current = frontend(messageId);
  if (!current) return null;
  const { game } = current;
  const cache = cacheFor(game);
  const index = game.isHistoryViewMode ? game.historyViewIndex : cache.length - 1;
  if (!Number.isInteger(index) || index! < 0 || index! >= cache.length) throw new Error('认不出前端正显示着哪一回合的历史。');
  const turn = cache[index!];
  const displayed = game._getCurrentViewSnapshot?.();
  if (game.isHistoryViewMode && displayed && displayed.message !== turn.message) {
    throw new Error('前端还在切历史回合呢，稍等一下再点。');
  }
  const signature = turnSignature(turn);
  const unique = cache.filter(item => turnSignature(item) === signature).length === 1;
  const key = historyKey(game);
  if (!runtimeIds.has(turn)) runtimeIds.set(turn, ++nextRuntimeId);
  const turnId = JSON.stringify(['frontend-turn', key, unique ? signature : `session-${runtimeIds.get(turn)}`]);
  return { text: turn.message, turnId, historyId: key && unique ? turnId : null };
}

/** Pin the exact frontend instance and turn before any model/network await. */
export function captureEmbeddedWrite(messageId: number, original: string) {
  const current = frontend(messageId);
  if (!current) return null;
  const { frame, game, win } = current;
  requireIdle(game, win);
  const cache = cacheFor(game);
  const target = cache[cache.length - 1];
  if (target.message !== original) throw withFault(new Error('前端这一回合跟酒馆正文对不上号，先别改缓存；让前端先同步一下。'), 'host');
  const length = cache.length;
  const key = historyKey(game);
  const storage = win.AppStorage;
  const saveData = storage?.saveData;
  if (!key || !storage || typeof saveData !== 'function') throw withFault(new Error('这个前端没给出能确认存盘的接口，画匣没敢把图写进去。'), 'host');

  const assertCurrent = (expected = original) => {
    const now = frontend(messageId);
    if (!now || now.frame !== frame || now.game !== game || now.win !== win
      || game.chatHistoryCache !== cache || cache.length !== length || cache[length - 1] !== target
      || target.message !== expected || historyKey(game) !== key || win.AppStorage !== storage
      || storage.saveData !== saveData) throw new Error('刚才前端回合变了，这次的结果没往前端缓存里写。');
    requireIdle(game, win);
  };
  return {
    assertCurrent,
    async save(nextText: string): Promise<void> {
      assertCurrent();
      const copy = structuredClone(cache);
      copy[length - 1].message = nextText;
      // Preserve live rendering while persisting a detached snapshot. A failure
      // is reported to the caller instead of being silently treated as success.
      target.message = nextText;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let confirmed = false;
      try {
        const result = await Promise.race([
          saveData.call(storage, key, copy, { silent: true }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('前端存历史等太久超时了。')), 30_000); }),
        ]);
        if (result === false) throw new Error('前端那边拒收这次历史缓存保存。');
        confirmed = true;
        assertCurrent(nextText);
      } catch (error) {
        // Never roll back a different turn or a newer write.
        if (!confirmed && game.chatHistoryCache === cache && cache.length === length && cache[length - 1] === target
          && target.message === nextText) target.message = original;
        throw error;
      } finally { clearTimeout(timer); }
    },
  };
}
