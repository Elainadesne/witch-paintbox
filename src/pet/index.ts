import { bindLauncher } from '../launcher.js';
import type { Position } from '../settings.js';
import type { PetHandle, PetOptions, PetPlacement } from './api.js';
import { Acts } from './acts.js';
import { Paintbox } from './box.js';
import { conduct } from './conductor.js';
import { Effects } from './effects.js';
import { Input } from './input.js';
import { Motion } from './motion.js';
import { measureView, Places, restingCorner } from './placement.js';
import { Speech } from './speech.js';
import { Stage, type StageParts } from './stage.js';
import { Rig } from './tia.js';

export type { PetHandle, PetOptions, PetPlacement, PetPreferences, PetSpot } from './api.js';

const PALETTE_KEY = 'witch-paintbox:pet-palette';

interface Core {
  reset(): void;
  setPosition(position: Position): void;
  getPosition(): Position;
  setPlacement(placement: PetPlacement | null): void;
  anchor(): DOMRect;
  dismiss(): void;
}

/**
 * Tia, the paintbox's desktop pet. Null when she cannot run here: the plugin keeps its old floating ball then. While
 * her pictures load the old ball stands in (and stays, if they cannot load).
 */
export function bindPet(options: PetOptions): PetHandle | null {
  if (typeof window.PointerEvent !== 'function' || typeof ResizeObserver !== 'function' || typeof createImageBitmap !== 'function'
    || typeof window.matchMedia !== 'function' || options.signal.aborted) return null;
  const { launcher, signal } = options;
  let placement: PetPlacement | null = options.placement;
  const interim = new AbortController();
  signal.addEventListener('abort', () => interim.abort(), { once: true });
  const ball = bindLauncher(launcher, options.initial, position => options.onMove(position, { ...placement }), options.onOpen, interim.signal, options.onDrag);
  let core: Core | null = null;
  void start(options, () => placement, interim).then(made => { core = made; }).catch(() => { core = null; });
  return {
    reset: () => { placement = null; if (core) core.reset(); else ball.reset(); },
    setPosition: position => (core ? core.setPosition(position) : ball.setPosition(position)),
    getPosition: () => (core ? core.getPosition() : ball.getPosition()),
    setPlacement: next => { placement = next; core?.setPlacement(next); },
    anchor: () => (core ? core.anchor() : launcher.getBoundingClientRect()),
    dismiss: () => { if (core) core.dismiss(); else launcher.hidden = true; },
  };
}

async function start(options: PetOptions, placement: () => PetPlacement | null, interim: AbortController): Promise<Core | null> {
  const { root, launcher, signal } = options;
  const url = (file: string) => new URL(`../../pet/${file}`, import.meta.url).href;
  // her sheet, linked into the plugin's shadow root as its own is
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = url('pet.css');
  const loaded = new Promise<boolean>(resolve => {
    sheet.addEventListener('load', () => resolve(true), { once: true });
    sheet.addEventListener('error', () => resolve(false), { once: true });
  });
  root.append(sheet);
  const local = new AbortController();
  signal.addEventListener('abort', () => local.abort(), { once: true });
  const life = local.signal;

  const rig = new Rig();
  const box = new Paintbox();
  let stage: Stage | null = null;
  let acts: Acts | null = null;
  let input: Input | null = null;
  const m = new Motion(rig, box, measureView(), {
    tuckIn: () => { void acts?.tuckIn(); },
    backToSide: () => { void acts?.backToSide(); },
    enterSide: spot => acts?.enterSide(spot),
    landed: () => acts?.landed(),
  });
  const effects = new Effects(m);
  const parts: StageParts = { m, rig, effects, speech: undefined as unknown as Speech, acts: undefined as unknown as Acts, input: () => input, url };
  stage = new Stage(parts, life);
  const speech = new Speech(m, stage.layer);
  parts.speech = speech;
  let lastAway = options.preferences().away;
  const wake = () => stage?.wake();
  acts = new Acts(m, effects, speech, {
    gfx: () => stage?.gfx ?? null,
    wake,
    settled: () => {
      const next = places.remember();
      if (next) options.onMove(restingCorner(m), next);
    },
    onAway: away => { lastAway = away; options.onAway(away); },
    onDrag: options.onDrag,
    keepPalette: colours => { try { localStorage.setItem(PALETTE_KEY, JSON.stringify(colours.map(c => c.map(v => Math.round(v))))); } catch { /* private mode */ } },
  });
  parts.acts = acts;
  const places = new Places(m, placement(), () => wake(), life);

  const fail = () => { local.abort(); sheet.remove(); stage?.dispose(); box.dispose(); return null; };
  try {
    if (!await loaded) return fail();
    await stage.load();
  } catch {
    return fail();
  }
  if (life.aborted) return fail();

  // the launcher becomes the hit shape: emptied, 0x0, in her layer, with the hit parts inside
  interim.abort();
  const home = { parent: launcher.parentNode, next: launcher.nextSibling, children: Array.from(launcher.childNodes) };
  const idleLabel = launcher.getAttribute('aria-label') ?? '';
  const idleTitle = launcher.title;
  launcher.classList.remove('generating', 'dragging');
  launcher.classList.add('pet');
  launcher.style.left = launcher.style.top = '';
  launcher.replaceChildren();
  stage.layer.append(launcher);
  root.append(stage.layer);
  input = new Input(m, launcher, {
    pickUp: (x, y) => acts!.pickUp(x, y),
    letGo: (x, y) => acts!.letGo(x, y),
    click: () => {
      if (acts!.changing) return;
      if (m.st.away) void acts!.comeBack();
      else options.onOpen();
    },
    near: () => stage?.near(),
    wake,
    canDrag: () => !acts!.changing,
    moveSmall: x => { m.st.boxAt = Math.max(m.smallWidth(), Math.min(m.view.w - m.smallWidth(), x)); wake(); },
    dropSmall: () => { const next = places.remember(); if (next) options.onMove(restingCorner(m), next); },
  }, life);

  // preferences: her lines, motion (and the system's reduced motion), and whether she rests in the paintbox
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => !stage!.hasGL || reduced.matches || options.preferences().motion === false;
  const prefs = () => {
    const now = options.preferences();
    speech.lines = now.lines !== false;
    m.still = still();
    if (now.away !== lastAway) {
      lastAway = now.away;
      if (now.away && !m.st.away) void acts!.dismiss();
      else if (!now.away && m.st.away) void acts!.comeBack();
    }
    wake();
  };
  reduced.addEventListener('change', prefs, { signal: life });
  window.addEventListener('witch-paintbox:preferences-changed', prefs, { signal: life });
  m.still = still();
  speech.lines = options.preferences().lines !== false;

  places.restore(options.initial);
  if (lastAway) {
    const st = m.st;
    st.away = true; st.alpha = st.alphaTo = 0;
    st.boxAt = st.P[0] - (st.onLeft ? -1 : 1) * m.fig() * 0.68;
    if (st.mode === 'side') st.boxAt = st.side?.dir === 'L' ? m.smallWidth() : m.view.w - m.smallWidth();
    st.mode = 'idle'; st.side = null; st.tucked = false; st.tk = 0;
    st.box.small = st.box.smallTo = 1;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PALETTE_KEY) ?? 'null') as unknown;
    if (Array.isArray(saved) && saved.length === 8 && saved.every(c => Array.isArray(c) && c.length === 3 && c.every(v => Number.isFinite(v)))) box.tint(saved as number[][], false);
  } catch { /* no palette yet */ }

  const status = (generating: boolean, queued: number) => {
    const text = `正在生图${queued ? ` · 还有 ${queued} 张排队` : ''}`;
    launcher.title = generating ? `${text} · 点击打开菜单` : idleTitle;
    launcher.setAttribute('aria-label', generating ? `${text}，${idleLabel}` : idleLabel);
    launcher.setAttribute('aria-busy', String(generating));
  };
  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    acts!.dead = true;
    local.abort();
    stage!.dispose();
    speech.dispose();
    box.dispose();
    sheet.remove();
    // (the plugin's launcher as it was, should the plugin live on)
    launcher.classList.remove('pet', 'hot', 'touch', 'dragging');
    launcher.replaceChildren(...home.children);
    launcher.title = idleTitle;
    launcher.setAttribute('aria-label', idleLabel);
    launcher.removeAttribute('aria-busy');
    if (home.parent?.isConnected) home.parent.insertBefore(launcher, home.next?.parentNode === home.parent ? home.next : null);
  };
  signal.addEventListener('abort', teardown, { once: true });
  conduct(m, acts, speech, {
    status,
    stop: teardown,
    wake,
    readTarget: floor => {
      stage!.readEl = floor === null ? null : document.querySelector(`#chat .mes[mesid="${floor}"] .mes_text`);
      stage!.dirty = true;
    },
  }, life);

  stage.ready = true;
  stage.start();
  return {
    reset: () => { places.forget(); places.home(); keepAway(); wake(); },
    setPosition: position => { places.apply(places.nearest(position)); keepAway(); wake(); },
    getPosition: () => { const r = m.boxRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; },
    setPlacement: next => { places.set(next); places.restore(null); keepAway(); wake(); },
    anchor: () => {
      // beside the paintbox, on the far side from her, so the menu never covers her
      const r = m.boxRect();
      let x0 = r.x, x1 = r.x + r.w;
      if (!m.st.away && m.visible()) {
        const b = rig.bounds(m.st.mode === 'side');
        x0 = Math.min(x0, Math.max(0, b.x0)); x1 = Math.max(x1, Math.min(m.view.w, b.x1));
      }
      return new DOMRect(x0, r.y, x1 - x0, r.h);
    },
    dismiss: () => { void acts!.dismiss(); },
  };

  // (moved while she rests in the paintbox: the small box goes with her spot)
  function keepAway() {
    const st = m.st;
    if (!st.away) return;
    st.alpha = st.alphaTo = 0;
    st.boxAt = st.P[0] - (st.onLeft ? -1 : 1) * m.fig() * 0.68;
    if (st.mode === 'side') st.boxAt = st.side?.dir === 'L' ? m.smallWidth() : m.view.w - m.smallWidth();
    st.mode = 'idle'; st.side = null; st.tucked = false; st.tk = 0;
  }
}
