import type { ImageProvider } from './image-settings.js';
import type { FloorTarget } from './pet-targets.js';

export type PetFault = 'reference' | 'setup' | 'host' | 'auth' | 'quota' | 'busy'
  | 'network' | 'timeout' | 'format' | 'decode' | 'storage' | 'unknown';

/** 'auto' = a floor picture started by 自动生图. Floor and auto events carry floor/turn. */
export type PetImageSource = 'floor' | 'auto' | 'config' | 'portrait';

export interface PetPicture {
  blob: Blob;
  width: number;
  height: number;
  /** Where it lands: the floor frame's rect for floors, an element for config/portrait, null when it has no place. */
  target(): FloorTarget | Element | null;
  /** Floors only: hides the picture in its frame until the returned function runs (or 4 s pass), so it can fly in. */
  veil?(): () => void;
}

/**
 * One id per click or automatic job ('image') and per run ('process').
 * Every start gets exactly one 'end'. An 'end' can also arrive without a start
 * (errors thrown before the start point, or a blocked click).
 * 'dropped' = ended with no message: the frame was disposed, or a finished picture was thrown away.
 */
export type PetEvent =
  | { type: 'process'; id: string; phase: 'reading' | 'thinking' | 'saving'; floor?: number; chars?: number; cancellable: boolean }
  | { type: 'image'; id: string; source: PetImageSource; phase: 'start' | 'queued' | 'generating';
      provider?: ImageProvider; position?: number; floor?: number; turn?: boolean; summary?: string;
      again?: boolean; columns?: number; width?: number; height?: number }
  | { type: 'end'; id: string; task: 'process' | 'image'; source?: PetImageSource;
      result: 'done' | 'failed' | 'cancelled' | 'dropped'; message: string; fault?: PetFault;
      floor?: number; added?: number; serverMayContinue?: boolean; paid?: boolean; picture?: PetPicture }
  | { type: 'history'; id: string; saved: boolean; pageOnly?: boolean; message: string }
  | { type: 'frames'; floor: number; targets: HTMLElement[] }
  | { type: 'auto'; waiting: number; active: boolean }
  | { type: 'ui'; action: 'menu-open' | 'menu-close' | 'panel-open' | 'panel-close' }
  | { type: 'stop' };

const listeners = new Set<(event: PetEvent) => void>();

export function onPetEvent(listener: (event: PetEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitPetEvent(event: PetEvent): void {
  for (const listener of listeners) {
    try { listener(event); }
    catch { /* A pet must never interrupt generation, saving or rendering. */ }
  }
}

/** Same id style as image-config.ts:10-12. */
export function petTaskId(): string {
  return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}

/** Lets only the first 'end' of a task through. */
export function petEnd(): (event: Extract<PetEvent, { type: 'end' }>) => void {
  let ended = false;
  return event => { if (!ended) { ended = true; emitPetEvent(event); } };
}

export function withFault<T extends Error>(error: T, fault: PetFault): T {
  return Object.assign(error, { fault });
}

export function petFault(error: unknown): PetFault {
  const fault = (error as { fault?: unknown } | null)?.fault;
  return typeof fault === 'string' ? fault as PetFault : 'unknown';
}
