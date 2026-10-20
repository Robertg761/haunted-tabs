import type { EffectName, Stage } from '../../shared/types';

/** What the background tells an effect about the tab it is haunting. */
export interface EffectContext {
  /** Decay stage the tab reached (1 withering … 4 entombed). Effects scale with it. */
  stage: Stage;
  /** How long the tab was neglected, in ms. */
  idleMs: number;
  /** Stable per-tab seed, so a tab's haunting looks the same each time. */
  seed: number;
  /** The user prefers reduced motion: no flashing, no fast movement; fades instead. */
  reduced: boolean;
}

/**
 * A page effect. Each one lives in its own file in this folder, draws only into
 * its own overlay (see overlay.ts), and leaves no trace once it is gone.
 */
export interface Effect {
  readonly name: EffectName;
  /** Begin. Calling again while running may refresh or intensify, never duplicate. */
  start(ctx: EffectContext): void;
  /** End gracefully: fade out, then remove everything. Used by Exorcise and sweeps. */
  stop(): void;
  /** Remove everything immediately: overlay, listeners, timers, animation frames. */
  destroy(): void;
  /** True while anything of this effect is in the page. */
  readonly active: boolean;
}
