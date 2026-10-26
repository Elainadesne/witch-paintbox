import type { PetHandle, PetOptions } from './api.js';

export type { PetHandle, PetOptions, PetPlacement, PetPreferences, PetSpot } from './api.js';

/** Tia, the paintbox's desktop pet. Null when she cannot run here: the plugin keeps its old floating ball then. */
export function bindPet(options: PetOptions): PetHandle | null {
  void options;
  return null;
}
