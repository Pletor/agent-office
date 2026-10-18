import './ui.css';
import { OPORA_TAB } from '../../../shared/opora';
import type { OporaState, StatusPanel, StatusReason } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { oporaPageUrl } from '../opora/full';
import { oporaLine } from './screen';

const LEVEL: Record<StatusReason['level'], string> = { bad: 'Pozor', warn: 'Rozpracováno', ok: 'V pořádku' };

const clock = (t?: number) => (t ? new Date(t).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const sha = (s?: string) => (s ? s.slice(0, 7) : '—');

/** The 🚦 Stav window: each panel's light, its reasons with where each is and what to do, and its links. */
export function openStatus(net: Net) {
  const close = h('button.btn.close', { 'aria-label': 'Zavřít' }, '✕');
  const body = h('div.body.status-wall');
  const el = h('div.modal.status-window', { role: 'dialog', 'aria-label': 'Stav' }, h('header', {}, h('h2', {}, '🚦 Stav kanceláře a Opory'), close), body);
  const render = () => paint(body, net);
  const offs = [store.on('status', render), store.on('opora', render)];
  const modal: Modal = openModal(el, { doing: '🚦 u stěny se stavem', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  // A fresh look as it opens, the remotes fetched too (unless they were a minute ago).
  net.send({ t: 'status.refresh' });
  render();
}

function paint(body: HTMLElement, net: Net) {
  const s = store.status;
  const top = h(
    'div.status-top',
    {},
    h('span.muted', {}, s?.checking ? '⏳ kontroluji…' : `zkontrolováno ${clock(s?.office.checkedAt)}`),
    h('span.muted', {}, `remote načten ${clock(s?.office.fetchedAt)}`),
    h('button.btn.small', { type: 'button', title: 'Zkontrolovat znovu (i s fetch)', onclick: () => net.send({ t: 'status.refresh' }) }, '↻ Zkontrolovat'),
  );
  if (!s) return body.replaceChildren(top, h('p.muted', {}, 'Čekám na první kontrolu…'));
  body.replaceChildren(top, section(s.office), section(s.opora, store.opora));
}

function section(p: StatusPanel, opora?: OporaState): HTMLElement {
  const links: Node[] = [];
  if (p.repo?.url) links.push(h('a.btn.small', { href: p.repo.url, target: '_blank', rel: 'noopener noreferrer' }, '↗ GitHub'));
  if (p.repo?.url) links.push(h('a.btn.small', { href: `${p.repo.url}/pulls`, target: '_blank', rel: 'noopener noreferrer' }, '↗ Pull requesty'));
  if (opora?.connected) links.push(h('a.btn.small', { href: oporaPageUrl(opora), target: OPORA_TAB, rel: 'noopener noreferrer' }, '↗ Otevřít Oporu'));
  const facts: Node[] = [];
  if (p.repo) {
    facts.push(h('div', {}, h('b', {}, 'Repozitář'), h('code', {}, p.repo.dir)));
    facts.push(h('div', {}, h('b', {}, p.repo.remote), h('code', {}, sha(p.repo.mainSha)), h('b', {}, ' · běží'), h('code', {}, sha(p.repo.runningSha))));
  }
  if (opora) facts.push(h('div', {}, h('b', {}, 'Most na tomto patře: '), oporaLine(opora), h('span.muted', {}, ` · ${opora.url}`)));
  return h(
    'section.status-panel',
    { class: p.light },
    h('div.status-head', {}, h('span.status-lamp', { class: p.light, 'aria-hidden': 'true' }), h('h3', {}, p.title), h('b.status-word', {}, p.summary), ...links),
    facts.length ? h('div.status-facts', {}, ...facts) : null,
    p.reasons.length ? h('ul.status-reasons', {}, ...p.reasons.map(reason)) : h('p.muted', {}, 'Zatím nic.'),
  );
}

function reason(r: StatusReason): HTMLElement {
  return h(
    'li',
    { class: r.level, title: LEVEL[r.level] },
    h('span.status-dot', { 'aria-label': LEVEL[r.level] }),
    h('span.status-text', {}, r.text, r.where ? h('code', {}, r.where) : null, r.fix ? h('span.status-fix', {}, `→ ${r.fix}`) : null),
    r.url ? h('a.btn.small', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, '↗') : null,
  );
}
