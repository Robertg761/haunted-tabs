// Pre-rendered bits for the cobwebs (dew beads, light glints) and the colours
// threads are drawn in, chosen per web from how light the page is beneath it.

import { clamp } from './cobwebs-model';

export const LEVELS = 6;
export const HUES = 12;

/**
 * How threads are stroked, per palette (0 light page, 1 mid tones, 2 dark page),
 * pass (0 under, 1 over) and width class (0 radials and frame, 1 spiral and loose ends).
 *
 * On white, real silk is a fine silvery grey that throws a faint shadow on the
 * wall behind: a grey thread over an offset cast shadow. On mid tones a dark
 * halo under a light core reads whatever the colour. On black, just the core.
 */
interface PaletteSpec {
  on: [boolean, boolean];
  rgb: [string, string];
  alpha: [[number, number], [number, number]];
  width: [[number, number], [number, number]];
  /** Offset of the under pass: a cast shadow rather than an outline. */
  offset: [number, number];
}

const SPECS: PaletteSpec[] = [
  {
    on: [true, true],
    rgb: ['10, 12, 22', '118, 122, 136'],
    alpha: [[0.15, 0.1], [0.82, 0.55]],
    width: [[1.35, 0.95], [1.0, 0.6]],
    offset: [0.8, 1.0],
  },
  {
    on: [true, true],
    rgb: ['16, 18, 26', '238, 241, 250'],
    alpha: [[0.3, 0.22], [0.85, 0.62]],
    width: [[1.6, 1.15], [0.9, 0.55]],
    offset: [0, 0],
  },
  {
    on: [false, true],
    rgb: ['0, 0, 0', '226, 231, 242'],
    alpha: [[0, 0], [0.78, 0.5]],
    width: [[0, 0], [0.95, 0.58]],
    offset: [0, 0],
  },
];

export const PASS_ON = SPECS.map((s) => s.on);
export const PASS_WIDTH = SPECS.map((s) => s.width);
export const PASS_OFFSET = SPECS.map((s) => s.offset);

/** [palette][pass][widthClass][alphaLevel] as ready-made CSS colours. */
export const strokeStyles: string[][][][] = SPECS.map((spec) =>
  [0, 1].map((pass) =>
    [0, 1].map((cls) =>
      Array.from({ length: LEVELS + 1 }, (_, l) => `rgba(${spec.rgb[pass]}, ${((l / LEVELS) * spec.alpha[pass][cls]).toFixed(3)})`),
    ),
  ),
);

/** Iridescent sheen colours: [palette][hue][alphaLevel]. */
export const sheenStyles: string[][][] = [0, 1, 2].map((p) =>
  Array.from({ length: HUES }, (_, h) =>
    Array.from({ length: LEVELS + 1 }, (_, l) => {
      // Pastel on white so it reads as a sheen, not a smudge; richer on dark.
      const a = (l / LEVELS) * (p === 0 ? 0.36 : 0.62);
      const light = p === 0 ? 62 : 76;
      const sat = p === 0 ? 70 : 90;
      return `hsla(${Math.round((h / HUES) * 360)}, ${sat}%, ${light}%, ${a.toFixed(3)})`;
    }),
  ),
);

/** Wrap any number into a hue bucket. */
export const hueIndex = (x: number): number => {
  const f = x - Math.floor(x);
  return Math.min(HUES - 1, Math.floor(f * HUES));
};

const dew: (HTMLCanvasElement | null)[] = [null, null];
let glints: HTMLCanvasElement[][] = [];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/**
 * A water bead 20px in radius centred in a 64px tile: a soft cast shadow, a
 * dark refracted rim, a bright caustic low down and a sharp highlight up top.
 * The light-page version has a darker rim and shadow so it reads on white.
 */
export function dewSprite(light: boolean): HTMLCanvasElement {
  const i = light ? 0 : 1;
  const cached = dew[i];
  if (cached) return cached;
  const [c, g] = canvas(64, 64);
  const cx = 32;
  const cy = 32;
  const r = 20;
  let grad = g.createRadialGradient(cx + 5, cy + 8, 0, cx + 5, cy + 8, r * 1.3);
  grad.addColorStop(0, `rgba(0,0,0,${light ? 0.32 : 0.25})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx + 5, cy + 8, r * 1.3, 0, Math.PI * 2);
  g.fill();
  // Body: the world seen upside down through water, dark round the rim.
  grad = g.createRadialGradient(cx, cy + 6, 2, cx, cy, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.6)');
  grad.addColorStop(0.5, light ? 'rgba(214,222,236,0.4)' : 'rgba(205,215,232,0.3)');
  grad.addColorStop(0.82, light ? 'rgba(78,86,104,0.62)' : 'rgba(80,88,106,0.45)');
  grad.addColorStop(1, light ? 'rgba(18,22,32,0.9)' : 'rgba(150,160,180,0.55)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  // Caustic: light focused through the bead pooling at its lower edge.
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(cx, cy, r - 4.5, Math.PI * 0.22, Math.PI * 0.78);
  g.stroke();
  // Specular highlight, up and to the left where the light is.
  grad = g.createRadialGradient(cx - 7, cy - 7.5, 0, cx - 7, cy - 7.5, 6.5);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx - 7, cy - 7.5, 6.5, 0, Math.PI * 2);
  g.fill();
  dew[i] = c;
  return c;
}

/**
 * A star-point of light with a faint rainbow halo, one per hue bucket. On white
 * pages a white point vanishes, so that version gets a thin dark rim and a
 * deeper colour, like a sparkle seen against a bright wall.
 */
export function glintSprite(h: number, light: boolean): HTMLCanvasElement {
  if (!glints.length) {
    glints = [true, false].map((lit) =>
      Array.from({ length: HUES }, (_, i) => {
        const [c, g] = canvas(32, 32);
        const hue = Math.round((i / HUES) * 360);
        const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.12, 'rgba(255,255,255,0.92)');
        if (lit) {
          grad.addColorStop(0.2, 'rgba(40,44,60,0.35)');
          grad.addColorStop(0.32, `hsla(${hue}, 80%, 55%, 0.4)`);
          grad.addColorStop(0.6, `hsla(${(hue + 40) % 360}, 80%, 55%, 0.1)`);
        } else {
          grad.addColorStop(0.3, `hsla(${hue}, 100%, 75%, 0.45)`);
          grad.addColorStop(0.6, `hsla(${(hue + 40) % 360}, 100%, 70%, 0.12)`);
        }
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 32, 32);
        // A faint cross flare, as light catching silk does.
        g.globalCompositeOperation = lit ? 'source-over' : 'lighter';
        for (const [w, hgt] of [[30, 1.2], [1.2, 30]]) {
          const lg = g.createRadialGradient(16, 16, 0, 16, 16, 15);
          lg.addColorStop(0, lit ? 'rgba(90,96,120,0.4)' : 'rgba(255,255,255,0.55)');
          lg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = lg;
          g.fillRect(16 - w / 2, 16 - hgt / 2, w, hgt);
        }
        return c;
      }),
    );
  }
  return glints[light ? 0 : 1][hueIndex(h / HUES)];
}

/** Forget the sprites (they are rebuilt on demand), so nothing lingers after teardown. */
export function dropSprites(): void {
  dew[0] = dew[1] = null;
  glints = [];
}

/** How light the page is under a point (0 black .. 1 white), looking through transparent layers. */
export function backgroundLum(x: number, y: number): number {
  try {
    const top = document.elementFromPoint(clamp(x, 1, innerWidth - 2), clamp(y, 1, innerHeight - 2));
    let el = top;
    while (el) {
      // Only a solid colour tells us anything; images and gradients alone are unknown.
      const c = readColor(getComputedStyle(el).backgroundColor);
      if (c && c[3] > 0.4) return luminance(c);
      el = el.parentElement;
    }
    // No solid colour anywhere (an image, say): the text colour gives it away.
    const text = readColor(getComputedStyle(top ?? document.body ?? document.documentElement).color);
    if (text && text[3] > 0.4) {
      const l = luminance(text);
      if (l > 0.62) return 0.12;
      if (l < 0.38) return 0.95;
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
 * Any CSS colour as RGBA. Plain rgb()/rgba() is read directly; other syntaxes
 * (oklch(), lab(), color(), which computed styles keep) are painted into a
 * 1x1 canvas and read back, since parsing those by hand lies.
 */
function readColor(css: string): number[] | null {
  if (!css || css === 'transparent') return null;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(css);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  if (!probe) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true });
    if (!probe) return null;
  }
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
