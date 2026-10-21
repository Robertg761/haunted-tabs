import { describe, expect, it } from 'vitest';
import {
  corruptTitle,
  formatIdle,
  hauntLevel,
  hauntedTitle,
  isHauntableUrl,
  poltergeistCooldownMs,
  poltergeistMessage,
  possessionMessage,
  shorten,
  siteName,
  skipDowntime,
  sleptMs,
  spokenDuration,
  stageFor,
  stageProgress,
  whisperMessage,
} from '../src/shared/haunt';
import { Stage } from '../src/shared/types';

const MIN = 60_000;

describe('stageFor', () => {
  it('walks through the stages at 1x, 2x, 4x and 8x the threshold', () => {
    expect(stageFor(0, 30)).toBe(Stage.Alive);
    expect(stageFor(29 * MIN, 30)).toBe(Stage.Alive);
    expect(stageFor(30 * MIN, 30)).toBe(Stage.Withering);
    expect(stageFor(60 * MIN, 30)).toBe(Stage.Ghost);
    expect(stageFor(120 * MIN, 30)).toBe(Stage.Dead);
    expect(stageFor(240 * MIN, 30)).toBe(Stage.Entombed);
    expect(stageFor(10_000 * MIN, 30)).toBe(Stage.Entombed);
  });

  it('supports the 30 second demo threshold', () => {
    expect(stageFor(29_000, 0.5)).toBe(Stage.Alive);
    expect(stageFor(31_000, 0.5)).toBe(Stage.Withering);
    expect(stageFor(2 * MIN + 1, 0.5)).toBe(Stage.Dead);
  });

  it('reports progress through a stage', () => {
    expect(stageProgress(45 * MIN, 30)).toBeCloseTo(0.5);
    expect(stageProgress(500 * MIN, 30)).toBe(1);
  });
});

describe('isHauntableUrl', () => {
  it('only allows normal web pages and files', () => {
    expect(isHauntableUrl('https://example.com/a')).toBe(true);
    expect(isHauntableUrl('http://localhost:3000')).toBe(true);
    expect(isHauntableUrl('file:///tmp/x.html')).toBe(true);
    expect(isHauntableUrl('chrome://settings')).toBe(false);
    expect(isHauntableUrl('chrome-extension://abc/popup.html')).toBe(false);
    expect(isHauntableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isHauntableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isHauntableUrl('https://addons.mozilla.org/en-US/firefox/')).toBe(false);
    expect(isHauntableUrl('about:config')).toBe(false);
    expect(isHauntableUrl('moz-extension://abc/popup.html')).toBe(false);
    expect(isHauntableUrl(undefined)).toBe(false);
    expect(isHauntableUrl('not a url')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats idle time compactly', () => {
    expect(formatIdle(5_000)).toBe('5s');
    expect(formatIdle(12 * MIN)).toBe('12m');
    expect(formatIdle(125 * MIN)).toBe('2h 5m');
    expect(formatIdle(26 * 60 * MIN)).toBe('1d 2h');
    expect(formatIdle(-5_000)).toBe('0s');
  });

  it('speaks durations like a ghost would', () => {
    expect(spokenDuration(10_000)).toBe('moments');
    expect(spokenDuration(MIN)).toBe('a minute');
    expect(spokenDuration(60 * MIN)).toBe('an hour');
    expect(spokenDuration(3 * 60 * MIN)).toBe('3 hours');
    expect(spokenDuration(2 * 24 * 60 * MIN)).toBe('2 days');
  });

  it('names sites', () => {
    expect(siteName('https://www.example.com/path')).toBe('example.com');
    expect(siteName('file:///home/me/notes.html')).toBe('notes.html');
    expect(siteName('file:///home/me/my%20notes.html')).toBe('my notes.html');
    expect(siteName('about:blank')).toBe('about:blank');
    expect(siteName('data:text/html,hi')).toBe('data');
  });
});

describe('titles', () => {
  const base = { realTitle: 'Inbox (3) - Mail', url: 'https://mail.example.com/', thresholdMinutes: 30, seed: 42 };

  it('leaves living tabs alone', () => {
    expect(hauntedTitle({ ...base, stage: Stage.Alive, idleMs: 0 })).toBe('Inbox (3) - Mail');
  });

  it('rots withering titles more as time passes, deterministically', () => {
    const early = hauntedTitle({ ...base, stage: Stage.Withering, idleMs: 31 * MIN });
    const late = hauntedTitle({ ...base, stage: Stage.Withering, idleMs: 59 * MIN });
    expect(early).not.toBe(base.realTitle);
    expect(early).toBe(hauntedTitle({ ...base, stage: Stage.Withering, idleMs: 32 * MIN }));
    const diff = (s: string) => Array.from(s).filter((c, i) => c !== Array.from(base.realTitle)[i]).length;
    expect(diff(late)).toBeGreaterThanOrEqual(diff(early));
  });

  it('gives ghosts, dead and entombed tabs their own voice', () => {
    expect(hauntedTitle({ ...base, stage: Stage.Ghost, idleMs: 61 * MIN }).startsWith('👻')).toBe(true);
    expect(hauntedTitle({ ...base, stage: Stage.Dead, idleMs: 121 * MIN }).startsWith('💀')).toBe(true);
    expect(hauntedTitle({ ...base, stage: Stage.Entombed, idleMs: 241 * MIN }).startsWith('⚰️')).toBe(true);
  });

  it('never leaves template placeholders behind', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const stage of [Stage.Ghost, Stage.Dead, Stage.Entombed]) {
        const t = hauntedTitle({ ...base, seed, stage, idleMs: 300 * MIN });
        expect(t).not.toMatch(/[{}]/);
      }
    }
  });

  it('falls back to the site name for untitled pages', () => {
    const t = hauntedTitle({ ...base, realTitle: '', stage: Stage.Withering, idleMs: 31 * MIN, seed: 1 });
    expect(t.length).toBeGreaterThan(0);
  });

  it('corrupts nothing at zero intensity', () => {
    expect(corruptTitle('hello world', 0, 7)).toBe('hello world');
  });

  it('builds possession messages', () => {
    for (let seed = 0; seed < 50; seed++) expect(possessionMessage(3 * 60 * MIN, seed)).not.toMatch(/[{}]/);
  });

  it('keeps dollar signs in titles literal', () => {
    // String.replace would read "$&" and "$'" in a replacement as patterns.
    const realTitle = "Save $& more, it's $' off";
    for (let seed = 0; seed < 200; seed++) {
      for (const stage of [Stage.Ghost, Stage.Dead, Stage.Entombed]) {
        const t = hauntedTitle({ ...base, realTitle, seed, stage, idleMs: 300 * MIN });
        if (t.includes('Save')) expect(t).toContain('Save $& more');
      }
      expect(poltergeistMessage(realTitle, seed)).toContain('$& MORE');
      expect(whisperMessage(realTitle, 3 * 60 * MIN, seed).message).toContain('$& more');
    }
  });

  it('never cuts an emoji or accent in half', () => {
    const family = '👨‍👩‍👧';
    const long = `${family} ${'é'.normalize('NFD')}`.repeat(20);
    const cut = shorten(long, 10);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/\u200d…|\ud83d…/);
    for (let seed = 0; seed < 50; seed++) expect(corruptTitle(`${family} Family photos`, 1, seed)).toContain(family);
    expect(corruptTitle('🎃🎃', 1, 3)).not.toBe('🎃🎃');
  });

  it('does not stack ellipses when a title is cut short', () => {
    const realTitle = 'A very long article title about nothing at all, really';
    for (let seed = 0; seed < 200; seed++) {
      for (const stage of [Stage.Ghost, Stage.Dead, Stage.Entombed]) {
        expect(hauntedTitle({ ...base, realTitle, seed, stage, idleMs: 300 * MIN })).not.toContain('……');
      }
    }
  });

  it('whispers in full sentences', () => {
    for (let seed = 0; seed < 50; seed++) {
      const w = whisperMessage('Inbox (3) - Mail', 3 * 60 * MIN, seed);
      expect(w.title.startsWith('👻')).toBe(true);
      expect(w.message).not.toMatch(/[{}]/);
    }
    expect(whisperMessage('x'.repeat(200), MIN, 1).message.length).toBeLessThan(140);
  });
});

describe('sleep', () => {
  const period = 30_000;

  it('reads ordinary alarm jitter as no sleep', () => {
    expect(sleptMs(1_000_000, 1_000_000 + period, period)).toBe(0);
    expect(sleptMs(1_000_000, 1_000_000 + 3 * period, period)).toBe(0);
  });

  it('measures a sleep from how late the alarm fired', () => {
    expect(sleptMs(1_000_000, 1_000_000 + 8 * 60 * MIN + period, period)).toBe(8 * 60 * MIN);
  });

  it('takes the downtime off tabs seen before the browser came back', () => {
    const now = 100 * MIN;
    expect(skipDowntime(10 * MIN, 20 * MIN, 60 * MIN, now)).toBe(70 * MIN);
    expect(skipDowntime(90 * MIN, 20 * MIN, 60 * MIN, now)).toBe(90 * MIN);
    // Used in the seconds between the last heartbeat and quitting: counts as seen on return.
    expect(skipDowntime(20 * MIN + 20_000, 20 * MIN, 60 * MIN, now)).toBe(80 * MIN);
    expect(skipDowntime(10 * MIN, 20 * MIN, 500 * MIN, now)).toBe(now);
    // A tab idle for 2 hours before an 8 hour night is still 2 hours idle after it.
    const night = 8 * 60 * MIN;
    const sleptAt = 1_000 * MIN;
    expect(sleptAt + night - skipDowntime(sleptAt - 120 * MIN, sleptAt, night, sleptAt + night)).toBe(120 * MIN);
  });
});

describe('hauntLevel', () => {
  it('is peaceful with a few fresh tabs', () => {
    expect(hauntLevel([Stage.Alive, Stage.Alive]).name).toBe('Peaceful');
  });

  it('grows with older tabs and with more tabs', () => {
    const few = hauntLevel([Stage.Ghost, Stage.Ghost, Stage.Ghost]);
    const old = hauntLevel([Stage.Dead, Stage.Dead, Stage.Entombed, Stage.Entombed, Stage.Entombed]);
    const crowd = hauntLevel(Array(60).fill(Stage.Alive));
    expect(old.index).toBeGreaterThan(few.index);
    expect(crowd.index).toBeGreaterThan(0);
    expect(hauntLevel(Array(40).fill(Stage.Entombed)).name).toBe('Damned');
    expect(hauntLevel(Array(40).fill(Stage.Entombed)).pct).toBe(1);
  });
});

describe('poltergeist cooldown', () => {
  it('stays between one and twenty minutes', () => {
    expect(poltergeistCooldownMs(0.5)).toBe(MIN);
    expect(poltergeistCooldownMs(30)).toBe(15 * MIN);
    expect(poltergeistCooldownMs(240)).toBe(20 * MIN);
  });
});
