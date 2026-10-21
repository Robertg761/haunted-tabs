// Pre-rendered bits for the cobwebs (dew beads, light glints) and the colours
// threads are drawn in, chosen per web from how light the page is beneath it.

import { clamp } from './cobwebs-model';

/** Thread styles: [palette][pass][widthClass][alphaLevel] as ready-made CSS colours. */
export const LEVELS = 6;
export const HUES = 12;

// Shadow under, silk on top: on white the shadow carries the thread and the
// light core reads as a glassy highlight; on black the core carries it.
const SHADOW_ALPHA = [0.34, 0.3, 0.2];
const CORE_ALPHA = [0.6, 0.78, 0.7];
export const SHADOW_WIDTH = [1.55, 1.15];
export const CORE_WIDTH = [0.8, 0.58];

export const strokeStyles: string[][][][] = [0, 1, 2].map((p) =>
  [0, 1].map((pass) =>
    [0, 1].map(() =>
      Array.from({ length: LEVELS + 1 }, (_, l) => {
        const a = (l / LEVELS) * (pass ? CORE_ALPHA[p] : SHADOW_ALPHA[p]);
        return pass ? `rgba(238, 241, 250, ${a.toFixed(3)})` : `rgba(16, 18, 26, ${a.toFixed(3)})`;
      }),
    ),
  ),
);

/** Iridescent sheen colours: [palette][hue][alphaLevel]. */
export const sheenStyles: string[][][] = [0, 1, 2].map((p) =>
  Array.from({ length: HUES }, (_, h) =>
    Array.from({ length: LEVELS + 1 }, (_, l) => {
      // Pastel on white so it reads as a sheen, not a smudge; richer on dark.
      const a = (l / LEVELS) * (p === 0 ? 0.32 : 0.62);
      const light = p === 0 ? 66 : 76;
      const sat = p === 0 ? 70 : 90;
      return `hsla(${Math.round((h / HUES) * 360)}, ${sat}%, ${light}%, ${a.toFixed(3)})`;
    }),
  ),
);

let dew: HTMLCanvasElement | null = null;
let glints: HTMLCanvasElement[] = [];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/**
 * A water bead 10px in radius centred in a 32px tile: a soft cast shadow, a
 * dark refracted rim, a bright caustic low down and a sharp highlight up top.
 */
export function dewSprite(): HTMLCanvasElement {
  if (dew) return dew;
  const [c, g] = canvas(32, 32);
  const cx = 16;
  const cy = 16;
  const r = 10;
  // Shadow cast down and to the right, onto whatever is behind.
  let grad = g.createRadialGradient(cx + 2.5, cy + 4, 0, cx + 2.5, cy + 4, r * 1.25);
  grad.addColorStop(0, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx + 2.5, cy + 4, r * 1.25, 0, Math.PI * 2);
  g.fill();
  // Body: the world seen upside down through water, dark at the top rim.
  grad = g.createRadialGradient(cx, cy + 3, 1, cx, cy, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.55, 'rgba(205,215,232,0.32)');
  grad.addColorStop(0.85, 'rgba(70,78,96,0.5)');
  grad.addColorStop(1, 'rgba(20,24,34,0.7)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  // Caustic: light focused through the bead pooling at its lower edge.
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 1.6;
  g.beginPath();
  g.arc(cx, cy, r - 2.2, Math.PI * 0.2, Math.PI * 0.8);
  g.stroke();
  // Specular highlight, up and to the left where the light is.
  grad = g.createRadialGradient(cx - 3.4, cy - 3.6, 0, cx - 3.4, cy - 3.6, 3.4);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx - 3.4, cy - 3.6, 3.4, 0, Math.PI * 2);
  g.fill();
  dew = c;
  return c;
}

/** A star-point of light with a faint rainbow halo, one per hue bucket. */
export function glintSprite(h: number): HTMLCanvasElement {
  if (!glints.length) {
    glints = Array.from({ length: HUES }, (_, i) => {
      const [c, g] = canvas(32, 32);
      const hue = Math.round((i / HUES) * 360);
      const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.12, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.3, `hsla(${hue}, 100%, 75%, 0.45)`);
      grad.addColorStop(0.6, `hsla(${(hue + 40) % 360}, 100%, 70%, 0.12)`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 32, 32);
      // A faint cross flare, as light catching silk does.
      g.globalCompositeOperation = 'lighter';
      for (const [w, hgt] of [[30, 1.2], [1.2, 30]]) {
        const lg = g.createRadialGradient(16, 16, 0, 16, 16, 15);
        lg.addColorStop(0, 'rgba(255,255,255,0.55)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg;
        g.fillRect(16 - w / 2, 16 - hgt / 2, w, hgt);
      }
      return c;
    });
  }
  const i = Math.floor(h) % HUES;
  return glints[i >= 0 ? i : i + HUES] ?? glints[0];
}

/** Forget the sprites (they are rebuilt on demand), so nothing lingers after teardown. */
export function dropSprites(): void {
  dew = null;
  glints = [];
  probe = null;
}

/** How light the page is under a point (0 black .. 1 white), looking through transparent layers. */
export function backgroundLum(x: number, y: number): number {
  try {
    let el = document.elementFromPoint(clamp(x, 1, innerWidth - 2), clamp(y, 1, innerHeight - 2));
    while (el) {
      // Only a solid colour tells us anything; images and gradients alone are unknown.
      const c = readColor(getComputedStyle(el).backgroundColor);
      if (c && c[3] > 0.4) return luminance(c);
      el = el.parentElement;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    if (scheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches) return 0.1;
  } catch {
    // Unusual documents (SVG, XML) just get the default.
  }
  return 1;
}

let probe: CanvasRenderingContext2D | null = null;

/**
 * Any CSS colour as RGBA, by letting the browser paint it. Computed styles keep
 * modern syntaxes (oklch(), lab(), color()), so parsing the string by hand lies.
 */
function readColor(css: string): number[] | null {
  if (!css || css === 'transparent') return null;
  probe ??= canvas(1, 1)[1];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}

function luminance([r, g, b]: number[]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function paletteFor(lum: number): number {
  return lum > 0.62 ? 0 : lum > 0.3 ? 1 : 2;
}
