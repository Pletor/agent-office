// The third screen, full page (E at the south glass of the planning room): the prototype "Třetí obrazovka
// – relace" with the floor's live data. The goal with its three-level bar, the counts by state and the
// Claude limit; every session grouped by its Opora card with its sub-sessions and /btw questions (their
// reports fly up as they come); dead ends, orphans, who waits on a person and the follow-up work with
// ▶ Spustit; the Novinky strip; and a switch that outlines where each part's data comes from.

import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, toast, type Modal } from '../../ui/dom';
import type { FollowItem } from '../../../shared/sessions-attention';
import { GROUP_STATE_CZ, ROW_STATE_CZ, STALE_MIN, type Board, type BoardRow } from '../../../shared/sessions-board';
import type { SessionKid } from '../../../shared/protocol';
import { TOPICS, type SessionsData } from './data';
import { NEWS, NEWS_DOCS, NEWS_HEAD, SOURCES } from './news';
import './ui.css';

const esc = (t: unknown) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const money = (v: number) => `$${v.toFixed(2).replace('.', ',')}`;
export const agoTxt = (m: number) => (m <= 0 ? 'teď' : m < 60 ? `před ${m} min` : `před ${Math.floor(m / 60)} h ${m % 60} min`);
export const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : n ? String(n) : '—');
const CK = { pass: '✓ checky prošly', fail: '✕ checky padají', pending: '⏳ checky běží', none: 'bez checků' } as const;

type Filter = 'all' | 'att' | 'run' | 'human' | 'done';

export function statusPill(r: BoardRow): string {
  if (r.stale && r.st !== 'gone') return `<span class="pill stale" data-src="o">⚠ bez pohybu ${r.ago} min</span>`;
  return `<span class="pill">${ROW_STATE_CZ[r.st]}</span>`;
}

function segs(p: [number, number], running: boolean): string {
  const [d, t] = p;
  if (!t) return '<span style="color:var(--muted)">bez plánu</span>';
  let out = '';
  for (let i = 0; i < Math.min(t, 14); i++) out += `<i class="${i < d ? 'on' : i === d && running ? 'cur' : ''}"></i>`;
  return out;
}

function matches(r: BoardRow, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'att') return r.stale || r.st === 'human' || r.st === 'block' || r.st === 'gone' || r.group === 'off';
  if (f === 'run') return r.st === 'run' || r.st === 'start';
  return r.st === f;
}

function kidHtml(k: SessionKid, i: number, now: number): string {
  const ago = Math.max(0, Math.floor((now - k.at) / 60_000));
  const stale = k.state === 'run' && ago >= STALE_MIN;
  const rep = k.state === 'done' ? `<span class="rep">↑ ${esc(k.report || 'Hotovo')}</span>` : k.state === 'fail' ? `<span class="rep hot">✕ ${esc(k.report || 'Selhala')}</span>`
    : stale ? `<span class="rep hot">⚠ bez pohybu ${ago} min</span>` : '<span class="rep wait">hlásí po dokončení</span>';
  const st = k.state === 'done' ? 'done' : k.state === 'fail' ? 'fail' : 'run';
  return `<div class="kid sst sst-${st}${stale ? ' isstale' : ''}" data-k="${i}"><span class="dot"></span><span class="kt"><em>${k.kind === 'btw' ? '/btw' : 'pod-relace'}</em>${esc(k.name)}</span><span class="kl">${esc(k.state === 'run' ? k.last || 'pracuje' : k.state === 'done' ? 'Hotovo' : 'Selhala')} · ${agoTxt(ago)}</span>${rep}</div>`;
}

function rowHtml(r: BoardRow, now: number): string {
  const pr = r.pr ? `<div class="prc" data-src="d">PR #${r.pr.n} <span class="ck ${r.pr.ck}">${CK[r.pr.ck]}${r.pr.s === 'merged' ? ' · sloučen' : r.pr.s === 'draft' ? ' · koncept' : r.pr.s === 'closed' ? ' · zavřen' : ''}</span></div>` : '<div class="prc" data-src="d"><span class="ck none">bez PR</span></div>';
  const kids = r.kids.map((k, i) => kidHtml(k, i, now)).join('');
  const ghost = r.st === 'gone';
  return `<div class="rowwrap" data-id="${esc(r.id)}">
    <div class="row sst sst-${r.st}${r.stale ? ' isstale' : ''}${ghost ? ' ghost' : ''}" tabindex="0" role="button" aria-label="Detail relace ${esc(r.name)}">
      <span class="dot" data-src="d"></span>
      <div class="who" data-src="d"><span class="av" style="background:${esc(r.color)};${ghost ? 'color:var(--ink);border-style:dashed' : ''}">${esc(r.name[0] ?? '?')}</span><span class="nm">${esc(r.name)}<small>${esc(r.desk)}${r.role ? ` · ${esc(r.role)}` : ''}</small></span></div>
      <div class="task" data-src="d"><b>${esc(r.task)}</b><span>${statusPill(r)} ${esc(r.need || r.sum)}</span></div>
      <div class="last" data-src="${r.ago >= STALE_MIN ? 'o' : 'd'}"><span class="t">${esc(r.last)}</span><span class="ago${r.ago >= STALE_MIN && r.st !== 'done' ? ' hot' : ''}">${agoTxt(r.ago)}</span></div>
      <div class="plan" data-src="n"><span>Plán ${r.plan[0]}/${r.plan[1]}</span><div class="segs">${segs(r.plan, r.st === 'run')}</div></div>
      ${pr}
      <div class="cost" data-src="d">${r.cost ? money(r.cost) : '—'}<small>${tok(r.tokens)} tok.</small></div>
    </div>
    ${kids ? `<div class="kids" data-src="n">${kids}</div>` : ''}
  </div>`;
}

function treeHtml(b: Board, f: Filter, now: number): string {
  return b.groups.map((g) => {
    const rows = g.rows.filter((r) => matches(r, f));
    if (!rows.length) return '';
    const lv = g.lv ? `<span class="gp" data-src="o" title="naplánováno ${g.lv[0]} % · kód ${g.lv[1]} % · potvrzeno ${g.lv[2]} %"><span class="mini3"><i class="plan" style="width:${g.lv[0]}%"></i><i class="code" style="width:${g.lv[1]}%"></i><i class="hum" style="width:${g.lv[2]}%"></i></span>${g.lv[1]} % kód</span>` : '';
    const icon = g.focus ? '🎯 ' : g.id === 'off' ? '❓ ' : g.id === 'ctrl' ? '🧭 ' : '🗂️ ';
    return `<section class="grp${g.id === 'off' ? ' offplan' : ''}${g.focus ? ' focus' : ''}" data-group="${esc(g.id)}">
      <div class="grp-h" data-src="${g.id === 'off' ? 'o' : 'd'}"><span class="cn">${icon}${esc(g.name)}</span><span class="cardst ${g.st}">${GROUP_STATE_CZ[g.st]}</span><span class="path">${esc(g.path)}</span>${g.focus ? '<span class="cardst" style="background:#efe4fb">karta orchestrátora</span>' : ''}${lv}</div>
      <div class="rows">${rows.map((r) => rowHtml(r, now)).join('')}</div></section>`;
  }).join('') || `<div class="empty">${b.rows.length ? 'V tomhle filtru není žádná relace.' : 'Na patře zatím nesedí žádná relace. Usaď pracovníka u stolu, vezmi kartu z Opory, nebo spusť navazující práci.'}</div>`;
}

function attHtml(a: ReturnType<SessionsData['board']>['att']): string {
  const it = (x: { row?: string; title: string; tag: string; why: string }) => `<div class="it"${x.row ? ` data-open="${esc(x.row)}"` : ''}><span><b>${esc(x.title)}</b></span><span class="tg">${esc(x.tag)}</span><span class="why">${esc(x.why)}</span></div>`;
  const fol = (x: FollowItem) => `<div class="it" data-follow="${esc(x.key)}"><span><b>${esc(x.title)}</b></span><button class="sbtn sm go" type="button" data-launch="${esc(x.key)}">▶ Spustit</button><span class="why">${esc(x.why)}</span></div>`;
  const box = (cls: string, ico: string, t: string, items: string[], src: string) => `<div class="box ${cls}" data-src="${src}"><div class="box-h">${ico} ${t} <i class="src ${src}">${src.toUpperCase()}</i><span class="n">${items.length}</span></div><div class="items">${items.join('') || '<div class="empty">Nic tu není.</div>'}</div></div>`;
  return box('dead', '⚠️', 'Slepé uličky', a.dead.map(it), 'o') + box('orph', '👻', 'Sirotci a práce mimo plán', a.orph.map(it), 'o') + box('hum', '🙋', 'Čeká na člověka / blokováno', a.hum.map(it), 'd') + box('fol', '💡', 'Navazující práce', a.fol.map(fol), 'n');
}

const LIMIT_CZ = (label: string) => label.replace(/^5h session$/i, '5h relace').replace(/^week$/i, 'Týden').replace(/^(.+) week$/i, '$1 týden');

function limitsHtml(): string {
  const w = store.limits.windows.slice(0, 3).map((x) => `<div class="lim"><span>${esc(LIMIT_CZ(x.label))}</span><b><i class="${x.pct >= 50 ? 'hot' : ''}" style="width:${Math.min(100, Math.round(x.pct))}%"></i></b><em>${Math.round(x.pct)} %</em></div>`).join('')
    || '<div class="lim"><span>Limit</span><b><i style="width:0%"></i></b><em>nenačteno</em></div>';
  const u = store.usage, spent = u.today.cost, budget = u.budget;
  const spend = `<div class="lim"><span>Dnes</span><b><i class="${budget && spent >= budget * 0.8 ? 'hot' : ''}" style="width:${budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0}%"></i></b><em>${money(spent)}${budget ? ` / $${Number.isInteger(budget) ? budget : budget.toFixed(2).replace('.', ',')}` : ''}</em></div>`;
  return `<div class="k">Claude limit <i class="src d">D</i></div>${w}${spend}`;
}

export interface ScreenDeps {
  net: Net;
  data: SessionsData;
  openDetail(rowId: string): void;
}

export function openScreen(deps: ScreenDeps): Modal {
  const { data } = deps;
  let filter: Filter = 'all';
  let showSrc = false;
  const clock = h('span');
  const counts = h('div.counts');
  const goal = h('div.goal-l');
  const limits = h('div.limits', { 'data-src': 'd' });
  const tree = h('div.tree', { 'aria-label': 'Strom relací podle karet' });
  const att = h('aside.att', { 'aria-label': 'Pozornost orchestrátora' });
  const filters = h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
  const sw = h('button.sw', { type: 'button', role: 'switch', 'aria-checked': 'false' }, h('span.tr'), 'Zvýraznit zdroje dat');
  const title = h('small');
  const root = h('section.ss', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Relace k cíli' },
    h('header.scr-top', {}, h('div.ttl', {}, '🧭 Relace k cíli ', title), h('div.live', {}, h('i'), ' živě · ', clock)),
    h('div.bar', {}, h('span.k', {}, 'Zobrazit'), filters, h('span.spacer'), sw),
    h('div.legend', { 'aria-label': 'Legenda zdrojů dat' },
      h('span', {}, h('i.src.d', {}, 'D'), ' kancelář to ví dnes'), h('span', {}, h('i.src.o', {}, 'O'), ' odvozené z dnešních dat'), h('span', {}, h('i.src.n', {}, 'N'), ' nová data z přepisů relací')),
    h('div.goal', { 'data-src': 'o' }, goal, counts, limits),
    h('div.body', {}, tree, att));
  const news = h('div.news', { 'aria-label': 'Novinky' });
  news.innerHTML = `<div class="news-h"><span class="ttl2">📰 Novinky</span><span class="k">${esc(NEWS_HEAD)}</span><a href="${NEWS_DOCS}" target="_blank" rel="noopener">Dokumentace ↗</a></div><div class="news-row">${NEWS.map((x) => `<article class="nw" data-src="n">${x.video ? `<a class="vid" href="${x.u}" target="_blank" rel="noopener"><div><span>▶</span>Video z vlákna – přehrát na X</div></a>` : ''}<b>${esc(x.t)}</b><span>${esc(x.d)}</span><span class="use">${esc(x.use)}</span><a href="${x.u}" target="_blank" rel="noopener">Otevřít příspěvek ↗</a></article>`).join('')}</div>`;
  const map = h('details.map');
  const T = { d: 'Kancelář to ví dnes', o: 'Odvozené z dnešních dat', n: 'Nové – čte se z přepisů relací' } as const;
  map.innerHTML = `<summary>Odkud jsou data: dnes vs. nové</summary><div class="map-g">${(['d', 'o', 'n'] as const).map((k) => `<div class="mcol ${k}"><h3><i class="src ${k}">${k.toUpperCase()}</i>${T[k]}</h3><ul>${SOURCES[k].map(([a, b]) => `<li>${esc(a)}<span>${esc(b)}</span></li>`).join('')}</ul></div>`).join('')}</div>`;
  root.append(news, map);

  let last = new Map<string, string>();
  let kidsWas = new Map<string, SessionKid['state']>();
  let countsWas: Record<string, number> = {};
  let follows: FollowItem[] = [];
  let first = true;

  function render() {
    const now = Date.now();
    const { board: b, att: a } = data.board();
    follows = a.fol;
    clock.textContent = new Date(now).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    title.textContent = `${store.opora.project?.name ?? 'patro bez Opory'} · orchestrátor řídí`;
    const F: [Filter, string][] = [['all', 'Vše'], ['att', '⚠ Pozornost'], ['run', 'Běží'], ['human', 'Čeká na člověka'], ['done', 'Hotovo']];
    filters.innerHTML = F.map(([k, l]) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${filter === k}">${l}</button>`).join('');
    goal.innerHTML = `<div class="k">Společný cíl <i class="src o">O</i></div><div class="goal-n">${esc(b.goal.name)}</div>
      <div class="goal-bar" title="naplánováno ${b.goal.lv[0]} % · kód ${b.goal.lv[1]} % · potvrzeno ${b.goal.lv[2]} % (${b.goal.evidence === 'opora' ? 'plán Lens z Opory' : 'odhad kanceláře z karet'})"><i class="plan" style="width:${b.goal.lv[0]}%"></i><i class="code" style="width:${b.goal.lv[1]}%"></i><i class="hum" style="width:${b.goal.lv[2]}%"></i></div>
      <div class="goal-lg"><span><b class="s plan"></b>naplánováno</span><span><b class="s code"></b>kód existuje</span><span><b class="s hum"></b>potvrzeno člověkem</span><span class="goaltxt mono">${b.rows.length} relací · ${b.kids} pod-relací · ${b.goal.cards} karet</span></div>`;
    const CNT: [keyof Board['counts'], string, string][] = [['run', 'běží', 'sst-run'], ['human', 'čeká na člověka', 'sst-human'], ['block', 'blokováno', 'sst-block'], ['done', 'hotovo', 'sst-done'], ['stale', 'bez pohybu', ''], ['gone', 'sirotci', 'sst-gone']];
    counts.innerHTML = CNT.map(([k, l, cls]) => `<button type="button" class="cnt sst ${cls}${!first && countsWas[k] !== undefined && countsWas[k] !== b.counts[k] ? ' bump' : ''}" data-f="${k === 'stale' || k === 'gone' ? 'att' : k === 'block' ? 'att' : k}" data-src="${k === 'stale' || k === 'gone' ? 'o' : 'd'}"><b style="background:${k === 'stale' ? '#ffb48f' : 'var(--c)'}">${b.counts[k]}</b>${l}</button>`).join('');
    countsWas = { ...b.counts };
    limits.innerHTML = limitsHtml();
    tree.innerHTML = treeHtml(b, filter, now);
    att.innerHTML = attHtml(a);

    // What moved since the last draw: a row flashes, a new one slides in, a sub-session's report flies up.
    const nextLast = new Map<string, string>();
    const nextKids = new Map<string, SessionKid['state']>();
    for (const r of b.rows) {
      const sig = `${r.last}|${r.st}|${r.plan.join('/')}`;
      nextLast.set(r.id, sig);
      const el = tree.querySelector<HTMLElement>(`.rowwrap[data-id="${CSS.escape(r.id)}"] .row`);
      if (!first && el && !last.has(r.id)) el.classList.add('new');
      else if (!first && el && last.get(r.id) !== sig) el.classList.add('flash');
      r.kids.forEach((k, i) => {
        const key = `${r.id}/${k.id}`;
        nextKids.set(key, k.state);
        if (!first && kidsWas.get(key) === 'run' && k.state === 'done') flyUp(r.id, i, k.report || 'Hotovo');
      });
    }
    last = nextLast;
    kidsWas = nextKids;
    first = false;
  }

  function flyUp(rowId: string, ki: number, text: string) {
    const wrap = tree.querySelector(`.rowwrap[data-id="${CSS.escape(rowId)}"]`);
    const kid = wrap?.querySelector(`.kid[data-k="${ki}"]`);
    const row = wrap?.querySelector('.row');
    if (!kid || !row) return;
    const scr = root.getBoundingClientRect(), a = kid.getBoundingClientRect(), b = row.getBoundingClientRect();
    const el = h('div.flyup', {}, `↑ ${text}`);
    el.style.left = `${a.left - scr.left + root.scrollLeft + 40}px`;
    el.style.top = `${a.top - scr.top + root.scrollTop}px`;
    root.append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transform = `translateY(${b.top - a.top + 4}px)`; }));
    setTimeout(() => { el.style.opacity = '0'; }, 1100);
    setTimeout(() => el.remove(), 2000);
  }

  function launch(key: string) {
    const f = follows.find((x) => x.key === key);
    if (!f) return;
    if (f.launch.kind === 'queue') {
      deps.net.send({ t: 'queue.add', prompt: f.launch.prompt, title: f.launch.title.slice(0, 100) });
      toast(`▶ Navazující práce je ve frontě: ${f.launch.title}`);
    } else {
      deps.net.send({ t: 'opora.take', cardId: f.launch.cardId });
      toast(`▶ Beru kartu: ${f.title.replace(/^Vzít kartu /, '')}`);
    }
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const l = t.closest<HTMLElement>('[data-launch]');
    if (l) { e.stopPropagation(); (l as HTMLButtonElement).disabled = true; launch(l.dataset.launch!); return; }
    const f = t.closest<HTMLElement>('[data-filter]');
    if (f) { filter = f.dataset.filter as Filter; render(); return; }
    const c = t.closest<HTMLElement>('.cnt');
    if (c) { filter = c.dataset.f as Filter; render(); return; }
    if (t.closest('.sw')) { showSrc = !showSrc; sw.setAttribute('aria-checked', String(showSrc)); root.classList.toggle('show-src', showSrc); return; }
    const o = t.closest<HTMLElement>('[data-open]');
    if (o) { deps.openDetail(o.dataset.open!); return; }
    const r = t.closest<HTMLElement>('.rowwrap');
    if (r && t.closest('.row')) deps.openDetail(r.dataset.id!);
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && t.classList.contains('row')) { e.preventDefault(); deps.openDetail(t.closest<HTMLElement>('.rowwrap')!.dataset.id!); }
  });

  let frame = 0;
  const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const offs = TOPICS.map((t) => store.on(t, later));
  const offData = data.onChange(later);
  const tick = setInterval(later, 20_000);
  data.refresh();
  const modal = openModal(root, { doing: '🧭 sleduje relace k cíli', onClose: () => { offs.forEach((off) => off()); offData(); clearInterval(tick); cancelAnimationFrame(frame); } });
  render();
  return modal;
}
