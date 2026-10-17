import './ui.css';
import { PLANS_DIR } from '../../../shared/planning';
import type { Plan } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { dictateField } from '../../ui/dictate';
import { h, openModal, timeAgo, STATUS_LABEL, type Modal } from '../../ui/dom';
import { confirmDialog } from '../../ui/prompt';
import { providerPicker } from '../../ui/provider';
import { taskProgress } from './board';

export interface PlanningActions {
  openTerminal(workerId: string): void;
  showQueue(): void;
}

const STATUS: Record<Plan['status'], [string, string]> = {
  planning: ['working', '✍️ planning'],
  ready: ['needs_input', '📋 ready'],
  queued: ['done', '🛠️ on the queue'],
  stopped: ['exited', '⛔ stopped'],
};

/**
 * The planning room's window. With a plan on the board it shows how it's going, and once it's
 * written, its tasks to pick from and hand to the queue; otherwise it's the form that asks for one.
 */
export function openPlanning(net: Net, actions: PlanningActions) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, '🧭 Opora Control Center');
  const body = h('div.body.planning');
  const foot = h('footer');
  const el = h('div.modal.planning-window', { role: 'dialog', 'aria-label': 'Planning room' }, h('header', {}, title, close), body, foot);
  /** The tasks someone unticked, by plan and index: the rest go to the queue. */
  const skipped = new Set<string>();
  let form: ReturnType<typeof planForm> | null = null;
  const render = () => {
    const p = store.planning.current;
    if (p) {
      form = null;
      title.textContent = '🧭 Opora Control Center · plan';
      renderPlan(p, body, foot, net, actions, skipped, render);
      return;
    }
    if (!form) {
      form = planForm(net, () => modal.close());
      title.textContent = '🧭 Opora Control Center · new plan';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
  };
  const offs = [store.on('planning', render), store.on('workers', render), store.on('queue', render)];
  const modal: Modal = openModal(el, { doing: '🧭 in the planning room', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderPlan(p: Plan, body: HTMLElement, foot: HTMLElement, net: Net, actions: PlanningActions, skipped: Set<string>, again: () => void) {
  const [cls, words] = STATUS[p.status];
  const w = p.workerId ? store.workers.get(p.workerId) : undefined;
  const planner = h(
    'div.planning-planner',
    {},
    h('span.dot', { style: `background:${w?.color ?? '#adb5bd'}` }),
    h('b', {}, 'Planner'),
    h('span.muted', {}, p.workerName ?? '…'),
    w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : h('span.pill.exited', {}, 'gone home'),
    w ? h('button.btn.small', { type: 'button', title: 'Talk to the planner: ask it to change the plan', onclick: () => actions.openTerminal(w.id) }, '🖥️ Terminal') : null,
  );
  const onCanvas = (p.mode ?? 'file') !== 'file';
  const line =
    onCanvas && p.status === 'ready'
      ? p.mode === 'router'
        ? '🔀 Routed: the cards it gave a pipeline are ready for the office to take, in the 🛰️ Opora window.'
        : '🛰️ On the Opora canvas: open Opora to look it over and confirm, and the office takes its cards from the 🛰️ Opora window (or the autopilot does).'
      : p.status === 'planning'
      ? `Asked by ${p.by} ${timeAgo(new Date(p.startedAt).toISOString())}. The tasks show here once the planner ends its turn with them written.`
      : p.status === 'stopped'
        ? `⛔ ${p.reason ?? 'Stopped'}`
        : p.status === 'ready'
          ? 'Pick the tasks to hand to the 📋 queue: it seats a worker for each, in its own worktree. Want changes first? Tell the planner in its terminal.'
          : `Handed to the queue ${p.queuedAt ? timeAgo(new Date(p.queuedAt).toISOString()) : ''}. The workers carry it out from there.`;
  const key = (i: number) => `${p.id}:${i}`;
  const tasks = p.tasks.length && !onCanvas
    ? h(
        'ol.planning-tasks',
        {},
        ...p.tasks.map((t, i) => {
          const prog = taskProgress(t.queueId, store.queue);
          const box = h('input', { type: 'checkbox', 'aria-label': `Hand “${t.title}” to the queue` }) as HTMLInputElement;
          box.checked = !t.queueId && !skipped.has(key(i));
          box.disabled = !!t.queueId || p.status === 'planning' || p.status === 'stopped';
          box.addEventListener('change', () => {
            if (box.checked) skipped.delete(key(i));
            else skipped.add(key(i));
            again();
          });
          return h(
            'li',
            {},
            h('label.planning-task', {}, box, h('b', {}, t.title), h('span.planning-progress', { title: prog.task?.error ?? '' }, `${prog.icon} ${prog.words}`)),
            h('details', {}, h('summary', {}, 'What the worker is told'), h('pre.planning-text', {}, t.text)),
          );
        }),
      )
    : null;
  body.replaceChildren(
    ...present(
      h('div.planning-head', {}, h('span.pill', { class: cls }, words), h('span.planning-title', { title: p.goal }, p.title)),
      h('p.planning-line', {}, line),
      planner,
      h('details.planning-goal', {}, h('summary', {}, 'What it’s a plan for'), h('pre.planning-text', {}, p.goal)),
      tasks,
      h('div.planning-out', {}, h('div.planning-out-head', {}, h('b', {}, '📄 '), h('code', {}, p.file)), h('pre.planning-preview', {}, p.preview?.trim() ? p.preview : p.status === 'planning' ? 'Nothing written yet.' : 'Nothing was written.')),
      store.planning.past.length
        ? h('details.planning-past', {}, h('summary', {}, `Earlier plans (${store.planning.past.length})`), h('ul', {}, ...store.planning.past.map((r) => h('li', { title: r.file }, h('b', {}, r.title), h('span.muted', {}, ` · ${r.tasks} task${r.tasks === 1 ? '' : 's'} · ${r.by} · ${STATUS[r.status][1]}`)))))
        : null,
    ),
  );
  const picked = p.tasks.map((t, i) => (!t.queueId && !skipped.has(key(i)) ? i : -1)).filter((i) => i >= 0);
  const canHand = !onCanvas && (p.status === 'ready' || p.status === 'queued') && picked.length > 0;
  foot.replaceChildren(
    ...present(
      h('span.grow', {}, p.status === 'planning' ? 'The planner writes only the plan: nothing in the project changes.' : 'Clearing the room sends the planner home. The plan file stays.'),
      p.status === 'planning' ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Stop planning?', 'The planner stops where it is. What it wrote so far stays in the file.', 'Stop it', () => net.send({ t: 'planning.stop' })) }, '⛔ Stop') : null,
      p.status !== 'planning' ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Clear the room?', 'The plan goes to the earlier ones and the planner goes home. Tasks already on the queue carry on.', 'Clear it', () => net.send({ t: 'planning.clear' })) }, '🧹 Clear the room') : null,
      p.status === 'queued' ? h('button.btn', { type: 'button', onclick: () => actions.showQueue() }, '📋 Open the queue') : null,
      !onCanvas && (p.status === 'ready' || p.status === 'queued')
        ? h('button.btn.primary', { type: 'button', disabled: !canHand, onclick: () => net.send({ t: 'planning.queue', tasks: picked }) }, `▶ Hand ${picked.length} task${picked.length === 1 ? '' : 's'} to the queue`)
        : null,
    ),
  );
}

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** The form that asks for a plan: what it's for, a title, and who plans it. */
function planForm(net: Net, done: () => void) {
  const goal = h('textarea', { rows: 6, placeholder: 'What to plan: e.g. “Let people export their boards as PDF, with a button in the board’s menu”', 'aria-label': 'What to plan' }) as HTMLTextAreaElement;
  const titleIn = h('input', { type: 'text', placeholder: 'Title (optional): the first line otherwise', maxlength: 100, 'aria-label': 'Title' }) as HTMLInputElement;
  const provider = providerPicker(store.project, 'planning-provider', 'Planner');
  const go = h('button.btn.primary', { type: 'button' }, '🧭 Plan it') as HTMLButtonElement;
  const refresh = () => {
    go.disabled = !goal.value.trim();
  };
  goal.addEventListener('input', refresh);
  go.addEventListener('click', () => {
    if (!goal.value.trim() || !provider.valid()) return;
    net.send({ t: 'planning.start', goal: goal.value, title: titleIn.value.trim() || undefined, provider: provider.value(), model: provider.model(), effort: provider.effort() });
  });
  refresh();
  const body = h(
    'div.planning-form',
    {},
    h('p.muted', {}, `A planner sits down at the table and writes the plan to ${PLANS_DIR}/, split into tasks. You pick which of them go on the 📋 task queue, and the other workers carry them out, each in its own worktree, each ending with a pull request. The tasks run on the same worker as the planner.`),
    h('div.planning-field', {}, h('label', {}, 'What should be planned?'), dictateField(goal)),
    h('div.planning-field', {}, h('label', {}, 'Title'), titleIn),
    provider.element,
  );
  setTimeout(() => goal.focus(), 0);
  return { body, foot: [h('span.grow'), h('button.btn', { type: 'button', onclick: done }, 'Cancel'), go] };
}
