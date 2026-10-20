// Possession: a short glitch that takes over the real page for about a second.
// Plays when you return to a dead tab, and when a poltergeist reaches into the
// tab you are on. Everything it adds is removed when it ends.
// Kept photosensitive-safe: at most one bright flash, no strobing, and a calm
// fade instead when the user prefers reduced motion.

const OUR_ATTR = 'data-haunted-tabs';

const GLITCH_CSS = `
:host { all: initial; }
.wrap { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 2147483647; }
.tint { position: absolute; inset: 0; }
.scan { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px); }
.vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 35%, rgba(20,0,10,.85) 100%); }
.slice { position: absolute; left: -5%; width: 110%; backdrop-filter: hue-rotate(140deg) saturate(3) contrast(1.4); -webkit-backdrop-filter: hue-rotate(140deg) saturate(3) contrast(1.4); }
.msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(90vw, 900px); text-align: center;
  font: 700 clamp(28px, 6vw, 84px)/1.05 "Courier New", ui-monospace, monospace; letter-spacing: .08em; color: #f5f0ff;
  text-shadow: -3px 0 rgba(255,0,60,.9), 3px 0 rgba(0,255,230,.8), 0 0 24px rgba(160,0,40,.9); white-space: pre-wrap; overflow-wrap: anywhere; }
.ghost { position: absolute; left: 50%; top: calc(50% - clamp(60px, 11vw, 150px)); transform: translate(-50%, -50%); font-size: clamp(40px, 8vw, 110px); filter: drop-shadow(0 0 18px rgba(255,255,255,.6)); }
`;

let glitching = false;

/** Hard cuts between keyframes. Easing in the options would apply to the whole run. */
function stepped(frames: Keyframe[]): Keyframe[] {
  return frames.map((f) => ({ ...f, easing: 'steps(1, end)' }));
}

/** The tab may still be hidden for a moment right after it is switched to. */
function whenVisible(timeoutMs: number): Promise<boolean> {
  if (document.visibilityState === 'visible') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', onChange);
      clearTimeout(timer);
      resolve(document.visibilityState === 'visible');
    };
    const onChange = () => document.visibilityState === 'visible' && done();
    const timer = setTimeout(done, timeoutMs);
    document.addEventListener('visibilitychange', onChange);
  });
}

export async function possess(message: string, durationMs: number): Promise<void> {
  if (glitching || !(await whenVisible(600))) return;
  glitching = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const host = document.createElement('div');
  host.setAttribute(OUR_ATTR, 'glitch');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = GLITCH_CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const vignette = document.createElement('div');
  vignette.className = 'vignette';
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.textContent = '👻';
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = message;
  wrap.append(vignette);
  root.append(style, wrap);

  const anims: Animation[] = [];
  const cleanups: (() => void)[] = [];
  const opts = (extra: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({ duration: durationMs, easing: 'linear', fill: 'forwards', ...extra });

  if (reduced) {
    wrap.append(ghost, msg);
    anims.push(wrap.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], opts({ easing: 'ease-in-out' })));
  } else {
    // The real page underneath rots: colours shift and it flashes inverted once.
    const tint = document.createElement('div');
    tint.className = 'tint';
    const scan = document.createElement('div');
    scan.className = 'scan';
    wrap.prepend(tint);
    wrap.append(scan);
    anims.push(
      tint.animate(
        stepped([
          { backdropFilter: 'none' },
          { backdropFilter: 'hue-rotate(90deg) saturate(2.5) contrast(1.3)', offset: 0.1 },
          { backdropFilter: 'invert(1) hue-rotate(180deg)', offset: 0.3 },
          { backdropFilter: 'grayscale(1) contrast(1.6) brightness(0.7)', offset: 0.38 },
          { backdropFilter: 'sepia(1) hue-rotate(-50deg) saturate(3)', offset: 0.65 },
          { backdropFilter: 'none' },
        ]),
        opts(),
      ),
    );
    for (let i = 0; i < 6; i++) {
      const slice = document.createElement('div');
      slice.className = 'slice';
      slice.style.top = `${Math.random() * 92}%`;
      slice.style.height = `${2 + Math.random() * 9}%`;
      wrap.append(slice);
      const dx = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 50);
      // Each slice jumps a few times, never faster than ~3 changes a second.
      anims.push(
        slice.animate(
          stepped([
            { transform: 'translateX(0)', opacity: 0 },
            { transform: `translateX(${dx}px)`, opacity: 1, offset: 0.05 + i * 0.04 },
            { transform: `translateX(${-dx * 0.6}px)`, opacity: 1, offset: 0.4 + i * 0.03 },
            { transform: `translateX(${dx * 0.3}px)`, opacity: 0.8, offset: 0.75 },
            { transform: 'translateX(0)', opacity: 0 },
          ]),
          opts(),
        ),
      );
    }
    wrap.append(ghost, msg);
    anims.push(
      msg.animate(
        stepped([
          { opacity: 0, transform: 'translate(-50%, -50%) skewX(0deg)' },
          { opacity: 1, transform: 'translate(-52%, -50%) skewX(-12deg)', offset: 0.12 },
          { opacity: 1, transform: 'translate(-48%, -51%) skewX(8deg)', offset: 0.45 },
          { opacity: 1, transform: 'translate(-50%, -50%) skewX(0deg)', offset: 0.8 },
          { opacity: 0, transform: 'translate(-50%, -50%) skewX(0deg)' },
        ]),
        opts(),
      ),
      ghost.animate([{ opacity: 0 }, { opacity: 0.95, offset: 0.2 }, { opacity: 0.95, offset: 0.7 }, { opacity: 0 }], opts()),
      // Fade the layers one by one: animating the wrapper's opacity would make it a
      // backdrop root and stop the backdrop filters from seeing the page.
      ...[vignette, scan].map((layer) => layer.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], opts())),
    );
    // And it shudders. Only the body moves, so our overlay stays put. Sideways
    // overflow is clipped for the moment so no scrollbar flashes up.
    if (document.body) {
      const html = document.documentElement;
      const overflowX = html.style.overflowX;
      html.style.overflowX = 'clip';
      cleanups.push(() => (html.style.overflowX = overflowX));
      anims.push(
        document.body.animate(
          stepped([
            { transform: 'none' },
            { transform: 'translateX(-8px) skewX(2deg)', offset: 0.1 },
            { transform: 'translateX(6px)', offset: 0.3 },
            { transform: 'translateX(-3px) skewX(-1deg)', offset: 0.38 },
            { transform: 'translateY(2px)', offset: 0.65 },
            { transform: 'none' },
          ]),
          opts({ fill: 'none' }),
        ),
      );
    }
  }

  document.documentElement.appendChild(host);
  return new Promise((resolve) => {
    setTimeout(() => {
      anims.forEach((a) => a.cancel());
      cleanups.forEach((fn) => fn());
      host.remove();
      glitching = false;
      resolve();
    }, durationMs);
  });
}