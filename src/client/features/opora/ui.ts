import './ui.css';
import { OPORA_LIMITS, OPORA_TAB, oporaCanvasUrl } from '../../../shared/opora';
import type { OporaCard, OporaState } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { dictateField } from '../../ui/dictate';
import { h, openModal, timeAgo, STATUS_LABEL, type Modal } from '../../ui/dom';

export interface OporaActions {
  openTerminal(workerId: string): void;
  showPlanning(): void;
}

const STATUS_WORDS: Record<OporaCard['status'], string> = {
  frontier: 'ready',
  claimed: 'held',
  blocked: 'blocked',
  waiting: 'waits on a person',
  closed: 'closed',
  needsRouting: 'needs a pipeline',
};

/**
 * The 🛰️ Opora window: the Opora Control Center's link to Opora Canvas. Opora plans (areas, sectors,
 * cards, pipelines); from here the office takes its cards, by hand or on the autopilot, and the
 * planner at the room's table plans onto the canvas or routes it.
 */
export function openOpora(net: Net, actions: OporaActions) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const body = h('div.body.opora');
  const foot = h('footer');
  const el = h('div.modal.opora-window', { role: 'dialog', 'aria-label': 'Opora' }, h('header', {}, h('h2', {}, '🛰️ Opora · Control Center'), close), body, foot);
  const goal = h('textarea', { rows: 3, placeholder: 'What to plan onto the canvas: e.g. “A settings page for notifications, designed first, then built”', 'aria-label': 'What to plan onto the Opora canvas' }) as HTMLTextAreaElement;
  const render = () => paint(store.opora, body, foot, net, actions, goal);
  const offs = [store.on('opora', render), store.on('workers', render), store.on('planning', render)];
  const modal: Modal = openModal(el, { doing: '🛰️ at the Opora screen', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  net.send({ t: 'opora.refresh' });
  render();
}

function paint(s: OporaState, body: HTMLElement, foot: HTMLElement, net: Net, actions: OporaActions, goal: HTMLTextAreaElement) {
  const linked = s.connected && !!s.project;
  const status = h(
    'div.opora-status',
    {},
    h('span.pill', { class: linked ? 'done' : 'needs_input' }, linked ? 'linked' : s.connected ? 'not linked' : 'not running'),
    h('b', {}, s.project ? s.project.name : 'Opora Canvas'),
    s.workspace ? h('span.muted', {}, `workspace ${s.workspace}`) : null,
    h('span.muted', {}, s.checkedAt ? `read ${timeAgo(new Date(s.checkedAt).toISOString())}` : ''),
    // The real Opora, in the same named tab the boss's chair opens (O there), on this floor's project.
    h('a.btn.small', { href: oporaCanvasUrl(s), target: OPORA_TAB, rel: 'noopener noreferrer', title: `Open Opora (${s.url}) on the whole screen, in its own tab` }, 'Open Opora ↗ full screen'),
    h('button.btn.small', { type: 'button', onclick: () => net.send({ t: 'opora.refresh' }) }, '↻'),
  );
  const parts: Node[] = [status];
  // Which Opora project this floor is on: picked here, or the one for the floor's folder. With
  // nothing linked, this is what to do next, so it sits right under the status.
  if (s.connected) {
    const folder = s.linkedBy === 'folder' && s.project ? `— by folder: ${s.project.name} —` : '— by folder —';
    const pick = h('select.provider-select', { 'aria-label': 'The Opora project this floor is linked to' }, h('option', { value: '' }, folder), ...s.projects.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
    pick.value = s.linkedBy === 'choice' && s.project ? s.project.id : '';
    pick.addEventListener('change', () => net.send({ t: 'opora.link', projectId: pick.value || null }));
    parts.push(h('label.opora-link', { class: linked ? '' : 'cta' }, h('b', {}, linked ? 'Linked to' : '👉 Link this floor to'), pick, linked ? null : h('span.muted', {}, 'pick the Opora project to read the canvas of')));
  }
  if (s.error) parts.push(h('p.opora-error', {}, s.error));
  if (!s.connected && s.canStart) parts.push(h('p', {}, h('button.btn', { type: 'button', disabled: s.starting, onclick: () => net.send({ t: 'opora.start' }) }, s.starting ? '⏳ Starting Opora…' : '▶ Start Opora'), h('span.muted', {}, ' from its repository (admins)')));
  if (!s.connected && !s.canStart) parts.push(h('p.muted', {}, 'Start Opora with `uv run opora` in its folder, or start the office with AGENT_OFFICE_OPORA_DIR set to it, and this window can start it for you.'));

  if (linked) {
    // The planning branch: the planner at the room's table works on the canvas.
    const busy = store.planning.current?.status === 'planning';
    parts.push(
      h(
        'section.opora-plan',
        {},
        h('h3', {}, '🧭 Plan on the canvas'),
        h('p.muted', {}, 'The planner at the room’s table lays the work out on Opora as sectors and cards (it shows you the batch before writing it), or routes the cards that have no pipeline yet. Design work goes to the design pipeline.'),
        dictateField(goal),
        h(
          'div.opora-row',
          {},
          h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => goal.value.trim() && net.send({ t: 'planning.start', goal: goal.value, mode: 'opora' }) }, '🗺️ Plan onto the canvas'),
          h('button.btn', { type: 'button', disabled: busy, onclick: () => net.send({ t: 'planning.start', goal: '', mode: 'router' }) }, '🔀 Route the cards'),
          busy ? h('button.btn', { type: 'button', onclick: () => actions.showPlanning() }, '✍️ The planner is at it…') : null,
        ),
      ),
    );
    // The doing branch: the office takes the cards.
    const max = h('select.provider-select', { 'aria-label': 'Cards at once' }, ...Array.from({ length: OPORA_LIMITS.maxRuns }, (_, i) => h('option', { value: String(i + 1) }, `${i + 1} at a time`))) as HTMLSelectElement;
    max.value = String(s.maxRuns);
    max.addEventListener('change', () => net.send({ t: 'opora.autopilot', on: s.autopilot, maxRuns: Number(max.value) }));
    parts.push(
      h(
        'section.opora-auto',
        {},
        h('label.opora-toggle', {}, h('input', { type: 'checkbox', checked: s.autopilot, onchange: (e: Event) => net.send({ t: 'opora.autopilot', on: (e.target as HTMLInputElement).checked, maxRuns: Number(max.value) }) }), h('b', {}, '🤖 Autopilot'), h('span.muted', {}, 'takes ready cards that have a pipeline, by itself')),
        max,
      ),
    );
    const runs = s.runs.filter((r) => r.state !== 'gone');
    if (runs.length) {
      parts.push(
        h('h3', {}, `🛠️ In the office · ${runs.length}`),
        h(
          'ul.opora-runs',
          {},
          ...runs.map((r) => {
            const w = r.workerId ? store.workers.get(r.workerId) : undefined;
            return h(
              'li',
              { class: r.group },
              h('b', {}, r.cardName),
              h('span.muted', {}, [r.sectorName, r.group === 'design' ? '🎨 design' : '💻 dev', r.workerName].filter(Boolean).join(' · ')),
              w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : null,
              r.error ? h('span.opora-error', { title: r.error }, '⚠️ lease') : null,
              w ? h('button.btn.small', { type: 'button', onclick: () => actions.openTerminal(w.id) }, '🖥️ Terminal') : null,
            );
          }),
        ),
      );
    }
    const bySector = new Map<string, OporaCard[]>();
    for (const c of s.cards) {
      const k = c.sectorName ?? 'Canvas';
      bySector.set(k, [...(bySector.get(k) ?? []), c]);
    }
    const held = new Set(runs.map((r) => r.cardId));
    parts.push(
      h('h3', {}, `🗂️ Cards on the canvas · ${s.cards.length}`),
      ...[...bySector.entries()].map(([sector, cards]) =>
        h(
          'details.opora-sector',
          { open: cards.some((c) => c.status === 'frontier') },
          h('summary', {}, `${sector} · ${cards.filter((c) => c.status === 'frontier').length} ready of ${cards.length}`),
          h(
            'ul.opora-cards',
            {},
            ...cards.map((c) =>
              h(
                'li',
                { class: c.group },
                h('span.opora-card-name', {}, `${c.group === 'design' ? '🎨 ' : ''}${c.name}`),
                h('span.muted', {}, [STATUS_WORDS[c.status], c.stage ?? c.profile].filter(Boolean).join(' · ')),
                c.status === 'frontier' && !held.has(c.id) ? h('button.btn.small', { type: 'button', title: 'Claim it on Opora and seat a worker for it', onclick: () => net.send({ t: 'opora.take', cardId: c.id }) }, '▶ Take') : null,
              ),
            ),
          ),
        ),
      ),
    );
  }
  body.replaceChildren(...parts);
  foot.replaceChildren(h('span.grow', {}, 'Opora plans, the office does it: each card gets a worker in its own worktree, which reports back to Opora. Closing a card is for a person, in Opora.'));
}
