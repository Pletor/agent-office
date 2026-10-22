// The window's tabs, each drawn from the board's data: the graph, the merge queue, the health and its
// Uklidit flow. The actions only ever POST what the person confirmed on screen.
import type { CleanLine, CleanupPlan, CleanupResult, GraphRow, QueueItem } from '../../../shared/cleanline';
import { h } from '../../ui/dom';
import { ago, laneColor, paintGraph } from './paint';

const ROW_H = 30;
const LANE_W = 18;

/** The full graph: lanes on a canvas beside one line per commit (refs, PR, subject, author, age). */
export function graphTab(d: CleanLine): HTMLElement {
  const rows = d.graph;
  if (!rows.length) return h('p.cl-empty', {}, d.error ?? 'Graf je prázdný.');
  const width = 24 + d.lanes * LANE_W;
  const canvas = h('canvas.cl-graph-canvas', { 'aria-hidden': 'true' });
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(rows.length * ROW_H * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${rows.length * ROW_H}px`;
  const g = canvas.getContext('2d');
  if (g) {
    g.scale(ratio, ratio);
    paintGraph(g, rows, { x: (l) => 14 + l * LANE_W, y: (i) => i * ROW_H + ROW_H / 2, rowH: ROW_H, dot: 5 }, 2);
  }
  const list = h('ol.cl-graph-rows', { style: `padding-left:${width}px` }, ...rows.map((r) => commitRow(r, d)));
  return h('div.cl-graph', {}, canvas, list);
}

function commitRow(r: GraphRow, d: CleanLine): HTMLElement {
  const pr = r.pr && d.repo.url ? h('a.cl-pr', { href: `${d.repo.url}/pull/${r.pr}`, target: '_blank', rel: 'noopener noreferrer' }, `#${r.pr}`) : r.pr ? h('span.cl-pr', {}, `#${r.pr}`) : null;
  return h('li.cl-row', { title: `${r.sha.slice(0, 10)} · ${r.author}`, style: `height:${ROW_H}px` },
    ...r.refs.map((ref) => h('span.cl-ref', { style: `border-color:${laneColor(r.lane)}` }, ref)),
    pr,
    h('span.cl-subject', { class: r.main ? '' : 'cl-side' }, r.subject.replace(/\s*\(#\d+\)\s*$/, '')),
    h('span.cl-meta', {}, `${r.author} · ${ago(r.time)} · ${r.sha.slice(0, 7)}`));
}

export interface Act {
  canAct: boolean;
  merge(pr: number): Promise<string | undefined>;
  plan(): Promise<CleanupPlan>;
  cleanup(keys: string[]): Promise<CleanupResult>;
}

const FLAG_TEXT: Record<string, string> = {
  stacked: 'řetěz', behind: 'pozadu', conflict: 'konflikt', draft: 'draft', 'checks-fail': 'červené kontroly',
  'checks-pending': 'kontroly běží', 'changes-requested': 'požadované změny', blocked: 'blokováno', unknown: 'nejasný stav',
};

/** The merge queue in order; Sloučit only on the head, only when it's green, only after a confirm. */
export function queueTab(d: CleanLine, act: Act): HTMLElement {
  const section = h('section.cl-queue', {}, h('p.muted', {}, 'Slučuje se v pořadí fronty, squash, jen zelené PR do main. Po sloučení vlastník fronty přeskládá další PR na nový main.'));
  if (d.queueNote) section.append(h('p.cl-note', {}, d.queueNote));
  if (!d.queue.length) section.append(h('p.cl-empty', {}, 'Žádné otevřené PR.'));
  d.queue.forEach((q, i) => section.append(queueCard(q, i, d, act)));
  return section;
}

function queueCard(q: QueueItem, i: number, d: CleanLine, act: Act): HTMLElement {
  const status = h('p.cl-action-status', { role: 'status' });
  const head = i === 0;
  const button = head && q.green && act.canAct ? h('button.btn.cl-merge', { type: 'button', 'data-cl-key': `merge-${q.number}` }, `Sloučit #${q.number}`) : null;
  const card = h('article.cl-card', { 'data-green': String(q.green), 'data-head': String(head) },
    h('header', {}, h('span.cl-pos', {}, head ? 'NA ŘADĚ' : `${i + 1}.`),
      q.url ? h('a', { href: q.url, target: '_blank', rel: 'noopener noreferrer' }, `#${q.number}`) : h('b', {}, `#${q.number}`),
      h('span.cl-title', {}, q.title)),
    h('p.cl-meta', {}, `${q.head} → ${q.base} · ${q.author || '?'} · ${q.createdAt ? ago(Date.parse(q.createdAt) / 1000) : ''}`),
    h('div.cl-flags', {}, q.green ? h('span.cl-flag.ok', {}, 'zelený') : null, ...q.flags.map((f) => h('span.cl-flag', { 'data-flag': f }, FLAG_TEXT[f] ?? f))),
    h('ul.cl-reasons', {}, ...q.reasons.map((r) => h('li', {}, r))),
    button, status);
  if (head && q.green && !act.canAct) status.textContent = 'Sloučit smí jen správce kanceláře.';
  if (button) button.onclick = () => {
    const yes = h('button.btn.danger', { type: 'button', 'data-cl-key': `merge-yes-${q.number}` }, `Ano, squash-sloučit #${q.number} do ${d.repo.remote}`);
    const no = h('button.btn', { type: 'button' }, 'Zrušit');
    const ask = h('div.cl-confirm', {}, h('p', {}, `Sloučit PR #${q.number} „${q.title}“ (squash, smazat větev)? Server znovu ověří, že je na řadě a zelený.`), yes, no);
    button.replaceWith(ask);
    no.onclick = () => ask.replaceWith(button);
    yes.onclick = async () => {
      yes.disabled = no.disabled = true;
      status.textContent = 'Slučuji…';
      const err = await act.merge(q.number);
      status.textContent = err ? `Nesloučeno: ${err}` : `PR #${q.number} sloučen. Nasaď main (server i klient) a ukliď větev.`;
      ask.remove();
    };
  };
  return card;
}

/** The health flags, and Uklidit: the exact list from the server, confirmed, then the outcome. */
export function healthTab(d: CleanLine, act: Act): HTMLElement {
  const section = h('section.cl-health', {},
    h('ul.cl-flags-list', {}, ...d.health.map((f) => h('li.cl-health-item', { 'data-level': f.level },
      h('b', {}, f.text), f.where ? h('span.cl-where', {}, f.where) : null, f.fix ? h('span.cl-fix', {}, `→ ${f.fix}`) : null))));
  const box = h('div.cl-cleanup');
  section.append(h('h3', {}, `Úklid (${d.counts.cleanup})`), h('p.muted', {}, 'Maže jen sloučené větve (lokálně i na remote) a sirotčí worktree bez neuložených změn a bez workera. Nikdy main, vybranou větev hlavního checkoutu ani cizí rozpracovanou práci. Před smazáním se každá větev zazálohuje do refs/cleanline-backup/.'), box);
  if (!act.canAct) box.append(h('p.cl-note', {}, 'Uklízet smí jen správce kanceláře.'));
  else {
    const start = h('button.btn', { type: 'button', 'data-cl-key': 'cleanup-plan' }, 'Uklidit… (ukázat přesný seznam)');
    box.append(start);
    start.onclick = async () => {
      start.disabled = true;
      try {
        showPlan(box, await act.plan(), act);
      } catch (err) {
        box.replaceChildren(h('p.cl-note', {}, `Seznam nelze načíst: ${(err as Error).message}`));
      }
    };
  }
  return section;
}

function showPlan(box: HTMLElement, plan: CleanupPlan, act: Act) {
  const checks = plan.items.map((it) => h('input', { type: 'checkbox', checked: true, value: it.key }));
  const KIND = { branch: 'větev', 'remote-branch': 'větev na remote', worktree: 'worktree' } as const;
  const go = h('button.btn.danger', { type: 'button', 'data-cl-key': 'cleanup-go' }, `Smazat vybrané (${plan.items.length})`);
  box.replaceChildren(
    h('h4', {}, plan.items.length ? 'Zmizí přesně toto:' : 'Není co uklízet.'),
    h('ul.cl-plan', {}, ...plan.items.map((it, i) => h('li', {}, h('label', {}, checks[i], ` ${KIND[it.kind]} `, h('code', {}, it.name), ` — ${it.reason}`)))),
    plan.kept.length ? h('details', {}, h('summary', {}, `Ponechá (${plan.kept.length})`), h('ul', {}, ...plan.kept.map((k) => h('li', {}, h('code', {}, k.name), ` — ${k.why}`)))) : '',
    plan.items.length ? go : '');
  go.onclick = async () => {
    const keys = checks.filter((c) => c.checked).map((c) => c.value);
    if (!keys.length) return;
    go.disabled = true;
    go.textContent = 'Mažu…';
    try {
      const r = await act.cleanup(keys);
      box.replaceChildren(h('h4.cl-result', {}, `Smazáno: ${r.done.length}, přeskočeno: ${r.skipped.length}`),
        h('ul', {}, ...r.done.map((x) => h('li', {}, `✓ ${x.name}`)), ...r.skipped.map((x) => h('li', {}, `– ${x.key}: ${x.why}`))),
        r.backup ? h('p.muted', {}, `Záloha: ${r.backup}`) : '');
    } catch (err) {
      box.append(h('p.cl-note', {}, `Úklid selhal: ${(err as Error).message}`));
    }
  };
}
