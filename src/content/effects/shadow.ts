// Something behind the text: a shadow figure passes behind the page content once, glimpsed while you read or scroll.
// STUB: replaced by the real effect. It only proves the wiring works.

import type { Effect, EffectContext } from './types';
import { createOverlay, type Overlay } from './overlay';

export class Shadow implements Effect {
  readonly name = 'shadow' as const;
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
