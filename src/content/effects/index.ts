// The page effects, by name. Each one lives in its own file in this folder.
import type { EffectName } from '../../shared/types';
import { Drips } from './drips';
import { Dust } from './dust';
import { Eyes } from './eyes';
import { Fog } from './fog';
import { GhostCursor } from './ghostCursor';
import { Shadow } from './shadow';
import type { Effect } from './types';

export const EFFECTS: Record<EffectName, () => Effect> = {
  dust: () => new Dust(),
  fog: () => new Fog(),
  eyes: () => new Eyes(),
  drips: () => new Drips(),
  shadow: () => new Shadow(),
  ghostCursor: () => new GhostCursor(),
};
