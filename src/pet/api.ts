import type { Position } from '../settings.js';

/** Where the player put her: on the floor at a share of the page's width (her feet), or in a side at a share of its height. */
export interface PetSpot { place: 'floor' | 'side'; edge: 'left' | 'right'; at: number }

/** One spot for wide pages and one for narrow ones (phones), so a desktop spot never lands on a phone. */
export interface PetPlacement { wide?: PetSpot; narrow?: PetSpot }

export interface PetPreferences {
  /** Her lines. Off: she says nothing; errors still show the plugin's own message. */
  lines: boolean;
  /** Off (or the system's reduced motion): she only breathes and blinks. */
  motion: boolean;
  /** She is inside the paintbox (关闭悬浮球); a click on the paintbox brings her out. */
  away: boolean;
}

export interface PetOptions {
  root: ShadowRoot;
  /** The plugin's real launcher button. The pet keeps it as its hit shape (aria, focus, keyboard and the menu rely on it). */
  launcher: HTMLButtonElement;
  /** The old ball's top-left corner, used when there is no placement for this layout yet. */
  initial: Position | null;
  placement: PetPlacement | null;
  /** Read again whenever 'witch-paintbox:preferences-changed' fires. */
  preferences(): PetPreferences;
  /** After she settles somewhere new by a drag: the paintbox's top-left corner, and the spot per layout. */
  onMove(position: Position, placement: PetPlacement): void;
  onAway(away: boolean): void;
  /** launcherMenu.toggle */
  onOpen(): void;
  /** launcherMenu.close */
  onDrag(): void;
  signal: AbortSignal;
}

export interface PetHandle {
  /** Home spot, placement forgotten (恢复默认偏好, an import without a position). */
  reset(): void;
  /** The old ball's top-left corner: she goes to the spot nearest to it. */
  setPosition(position: Position): void;
  /** The paintbox's top-left corner now (what the old ball's position meant). */
  getPosition(): Position;
  /** After an import: the stored spot for this layout, or home when there is none. */
  setPlacement(placement: PetPlacement | null): void;
  /** The paintbox's rect: the menu opens beside it. */
  anchor(): DOMRect;
  /** 关闭悬浮球: she climbs into the paintbox. */
  dismiss(): void;
}
