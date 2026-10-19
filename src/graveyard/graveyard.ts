import { formatIdle, siteName } from '../shared/haunt';
import { loadGraves, onGravesChanged, saveGraves } from '../shared/storage';
import type { Grave } from '../shared/types';
import { el, faviconUrl } from '../shared/ui';
import { ext } from '../shared/ext';

const gravesEl = document.getElementById('graves')!;
const searchInput = document.getElementById('search') as HTMLInputElement;
const resurrectAll = document.getElementById('resurrect-all') as HTMLButtonElement;
const summary = document.getElementById('summary')!;

let graves: Grave[] = [];

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function visible(): Grave[] {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return graves;
  return graves.filter((g) => g.title.toLowerCase().includes(q) || g.url.toLowerCase().includes(q));
}

function tombstone(g: Grave): HTMLElement {
  return el(
    'article',
    { class: 'stone', 'data-id': g.id },
    el('div', { class: 'rip', text: 'R.I.P.' }),
    el('img', { class: 'fav', src: faviconUrl(g.url, g.favIconUrl), alt: '', width: '24', height: '24' }),
    el('h2', { class: 'name', title: g.title, text: g.title }),
    el('a', { class: 'site', href: g.url, title: g.url, target: '_blank', rel: 'noreferrer', text: siteName(g.url) }),
    el(
      'p',
      { class: 'epitaph' },
      el('span', { text: `Died ${dateFmt.format(g.diedAt)}` }),
      el('span', { text: `Forgotten for ${formatIdle(g.idleMs)}` }),
      el('span', { class: 'cause', text: g.cause === 'haunting' ? 'Taken by the haunting' : 'Laid in the ground by you' }),
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', { class: 'btn raise', 'data-action': 'resurrect', text: '✨ Resurrect' }),
      el('button', { class: 'btn forget', 'data-action': 'forget', title: 'Remove this grave from the list', text: 'Lay to rest' }),
    ),
  );
}

function render(): void {
  const shown = visible();
  const n = graves.length;
  summary.textContent = n
    ? `${n} tab${n === 1 ? '' : 's'} buried here. Resurrect any of them to bring them back.`
    : 'Every tab the haunting takes will lie here. Nothing is ever lost.';
  resurrectAll.disabled = shown.length === 0;
  resurrectAll.textContent = shown.length && shown.length !== n ? `✨ Resurrect ${shown.length}` : '✨ Resurrect all';
  gravesEl.replaceChildren(
    ...(shown.length
      ? shown.map(tombstone)
      : [el('p', { class: 'empty', text: n ? 'No grave bears that name.' : 'No one is buried here. Yet.' })]),
  );
}

/** Reopen tabs first, and only then remove their graves, so a failure loses nothing. */
async function resurrect(ids: string[]): Promise<void> {
  const raised = new Set<string>();
  for (const id of ids) {
    const g = graves.find((x) => x.id === id);
    if (!g) continue;
    try {
      await ext.tabs.create({ url: g.url, active: false });
      raised.add(id);
    } catch (err) {
      console.warn('[haunted-tabs] could not resurrect', g.url, err);
    }
  }
  if (raised.size === 0) return;
  const current = await loadGraves();
  await saveGraves(current.filter((g) => !raised.has(g.id)));
}

gravesEl.addEventListener('click', async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const stone = button?.closest<HTMLElement>('[data-id]');
  if (!button || !stone) return;
  const id = stone.dataset.id!;
  if (button.dataset.action === 'resurrect') {
    stone.classList.add('rising');
    await resurrect([id]);
  } else if (button.dataset.action === 'forget') {
    const g = graves.find((x) => x.id === id);
    if (!g || !confirm(`Lay "${g.title}" to rest? It will be removed from the Graveyard. The page itself stays in your browser history.`)) return;
    const current = await loadGraves();
    await saveGraves(current.filter((x) => x.id !== id));
  }
});

resurrectAll.addEventListener('click', async () => {
  gravesEl.querySelectorAll('.stone').forEach((s) => s.classList.add('rising'));
  await resurrect(visible().map((g) => g.id));
});

searchInput.addEventListener('input', render);

onGravesChanged((next) => {
  graves = next;
  render();
});

loadGraves().then((g) => {
  graves = g;
  render();
});
