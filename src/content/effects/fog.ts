// Fogged glass: frost creeps in from the edges; moving the mouse wipes clear streaks that slowly mist over again.
// STUB: replaced by the real effect. It only proves the wiring works.

import type { Effect, EffectContext } from './types';
import { createOverlay, type Overlay } from './overlay';

export class Fog implements Effect {
  readonly name = 'fog' as const;
  private overlay: Overlay | null = null;
  private timer: number | undefined;

  get active(): boolean {
    return !!this.overlay;
  }

  start(_ctx: EffectContext): void {
    this.overlay ??= createOverlay(this.name);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.destroy(), 300);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.overlay?.remove();
    this.overlay = null;
  }
}
