/**
 * One full-window canvas for short-lived particles: glowing motes that rise
 * from a resurrected stone, and dust kicked up when stones rise or sink.
 * The animation loop only runs while particles are alive.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  kind: 'mote' | 'dust';
  hue: number;
  phase: number;
}

const MAX_PARTICLES = 320;

export class Particles {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly glow: HTMLCanvasElement;
  private particles: Particle[] = [];
  private running = false;
  private last = 0;
  private dpr = 1;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly enabled: () => boolean,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.glow = makeGlowSprite();
    addEventListener('resize', () => this.running && this.resize());
  }

  /** The canvas only has a bitmap (and only takes part in compositing) while particles are alive. */
  private resize(): void {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
  }

  /** Pale spectral motes drifting upward out of a rectangle (viewport coordinates). */
  motes(rect: DOMRect, count: number): void {
    if (!this.enabled() || !onScreen(rect)) return;
    for (let i = 0; i < count; i++) {
      this.add({
        x: rect.left + Math.random() * rect.width,
        y: rect.top + rect.height * (0.25 + Math.random() * 0.75),
        vx: (Math.random() - 0.5) * 18,
        vy: -(30 + Math.random() * 70),
        age: 0,
        life: 1.2 + Math.random() * 1.6,
        size: 3 + Math.random() * 7,
        kind: 'mote',
        hue: 140 + Math.random() * 40,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Earth and stone dust thrown up along a ground line. */
  dust(x: number, y: number, width: number, count: number, force = 1): void {
    if (!this.enabled() || y < -40 || y > innerHeight + 40) return;
    for (let i = 0; i < count; i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      this.add({
        x: x + (Math.random() - 0.5) * width,
        y: y - Math.random() * 6,
        vx: dir * (10 + Math.random() * 50) * force,
        vy: -(15 + Math.random() * 55) * force,
        age: 0,
        life: 0.8 + Math.random() * 1.1,
        size: 0.8 + Math.random() * 2.2,
        kind: 'dust',
        hue: 25 + Math.random() * 15,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  private add(p: Particle): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push(p);
    if (!this.running) {
      this.running = true;
      this.resize();
      this.canvas.classList.add('running');
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      alive.push(p);
      const t = p.age / p.life;
      if (p.kind === 'mote') {
        p.vx += Math.sin(p.phase + p.age * 3) * 20 * dt;
        p.vy -= 12 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        const flicker = 0.75 + 0.25 * Math.sin(p.phase + p.age * 14);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.max(0, fade * flicker * 0.9);
        const s = p.size * (1 - t * 0.4);
        ctx.drawImage(this.glow, p.x - s, p.y - s, s * 2, s * 2);
      } else {
        p.vy += 90 * dt;
        p.vx *= 1 - 1.8 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.max(0, (1 - t) * 0.7);
        ctx.fillStyle = `hsl(${p.hue} 22% ${38 + p.phase * 4}%)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.particles = alive;
    if (alive.length) requestAnimationFrame((t) => this.frame(t));
    else {
      this.running = false;
      this.canvas.classList.remove('running');
      this.canvas.width = this.canvas.height = 0;
    }
  }
}

function onScreen(r: DOMRect): boolean {
  return r.bottom > -40 && r.top < innerHeight + 40 && r.right > 0 && r.left < innerWidth;
}

function makeGlowSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(240, 255, 248, 1)');
  grad.addColorStop(0.18, 'rgba(190, 255, 225, 0.85)');
  grad.addColorStop(0.45, 'rgba(120, 230, 200, 0.25)');
  grad.addColorStop(1, 'rgba(100, 200, 190, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}
