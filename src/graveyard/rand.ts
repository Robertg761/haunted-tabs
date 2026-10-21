/** Small deterministic randomness, so each grave and the landscape look the same on every visit. */

export type Rand = () => number;

/** FNV-1a: a stable 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a tiny seeded generator returning numbers in [0, 1). */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: Rand, a: number, b: number): number => a + (b - a) * r();

export const pick = <T>(r: Rand, items: readonly T[]): T => items[Math.floor(r() * items.length)];

/** Round to one decimal for compact SVG path data. */
export const n1 = (v: number): string => (Math.round(v * 10) / 10).toString();
