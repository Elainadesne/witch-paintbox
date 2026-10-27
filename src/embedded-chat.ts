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
  if (matches.length > 1) throw withFault(new Error('当前楼层存在多个前端回合缓存，无法确认配图归属。'), 'host');
  return matches[0] ?? null;
}

function requireIdle(game: Game, win: Frontend): void {
  if (game.isBackgroundProcessing || win.LlmLock?.blockedReason?.()) {
    throw withFault(new Error('请等当前楼层前端完成后台结算后再处理。'), 'host');
  }
  if (game.isHistoryViewMode) throw withFault(new Error('当前处于前端历史回看模式，请先返回最新回合再处理。'), 'host');
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
    throw withFault(new Error('当前前端的回合缓存尚未就绪。'), 'host');
  }
  return cache;
}

export function readEmbeddedTurn(messageId: number) {
  const current = frontend(messageId);
  if (!current) return null;
  const { game } = current;
  const cache = cacheFor(game);
  const index = game.isHistoryViewMode ? game.historyViewIndex : cache.length - 1;
  if (!Number.isInteger(index) || index! < 0 || index! >= cache.length) throw new Error('无法确认前端正在展示的历史回合。');
  const turn = cache[index!];
  const displayed = game._getCurrentViewSnapshot?.();
  if (game.isHistoryViewMode && displayed && displayed.message !== turn.message) {
    throw new Error('前端正在切换历史回合，请稍后再试。');
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
  if (target.message !== original) throw withFault(new Error('前端当前回合与酒馆正文不同，未修改历史缓存；请先完成前端同步。'), 'host');
  const length = cache.length;
  const key = historyKey(game);
  const storage = win.AppStorage;
  const saveData = storage?.saveData;
  if (!key || !storage || typeof saveData !== 'function') throw withFault(new Error('前端未提供可确认的历史保存接口，暂不能写入配图。'), 'host');

  const assertCurrent = (expected = original) => {
    const now = frontend(messageId);
    if (!now || now.frame !== frame || now.game !== game || now.win !== win
      || game.chatHistoryCache !== cache || cache.length !== length || cache[length - 1] !== target
      || target.message !== expected || historyKey(game) !== key || win.AppStorage !== storage
      || storage.saveData !== saveData) throw new Error('前端回合已变化，本次结果没有写入前端缓存。');
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
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('前端历史保存超时。')), 30_000); }),
        ]);
        if (result === false) throw new Error('前端拒绝保存历史缓存。');
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
