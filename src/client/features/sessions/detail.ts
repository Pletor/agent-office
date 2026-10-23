// One session's detail over the third screen (click its row): what it needs from you (with Odpovědět,
// the terminal, or handing it to a person in the chat), its live checklist ticking off, its sub-sessions
// and /btw questions, where it runs, how full its context is, what it changed (the office's Changes
// read, while open), its spend and PR, its card's PR Lens (features/lens), and the orchestrator's
// actions: send it an instruction, stop it, put it on a card, send it home.

import type { Net } from '../../net';
import type { Messages } from '../../core/registry';
import type { ChangesState, ServerMsg } from '../../../shared/protocol';
import type { BoardRow } from '../../../shared/sessions-board';
import { store } from '../../state';
import { closeAllModals, h, openModal, toast, type Modal } from '../../ui/dom';
import { LensSection } from '../lens/ui';
import type { SessionsData } from './data';
import { agoTxt, money, statusPill, tok } from './screen';
import './detail.css';

const esc = (t: unknown) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface DetailDeps {
  net: Net;
  messages: Messages<ServerMsg>;
  data: SessionsData;
  /** Walks you to the worker's desk and opens its terminal. */
  answerWorker(id: string): void;
}

export function openSessionDetail(rowId: string, deps: DetailDeps): Modal | undefined {
  const find = () => deps.data.board().board.rows.find((r) => r.id === rowId);
  const first = find();
  if (!first) return undefined;
  const workerId = first.workerId;
  const head = h('header.m-h');
  const main = h('div.m-sec');
  const side = h('div.side');
  const lensBox = h('div.lensbox');
  const orch = h('div.orch');
  const el = h('section.ss-detail', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `Detail relace ${first.name}` }, head, h('div.m-g', {}, main, side), lensBox, orch);
  if (document.querySelector('.ss.show-src')) el.classList.add('show-src');
  let changes: ChangesState | undefined;
  let lens: { card: string; s: LensSection } | undefined;
  let ticked = new Set<string>();
  let saying: 'answer' | 'instruct' | 'assign' | undefined;

  const send = (text: string) => { if (workerId && text.trim()) { deps.net.send({ t: 'worker.prompt', workerId, prompt: text.trim() }); toast('💬 Posláno do relace'); } };

  function sayBox(kind: 'answer' | 'instruct'): HTMLElement {
    const input = h('input', { type: 'text', 'aria-label': kind === 'answer' ? 'Odpověď relaci' : 'Pokyn relaci', placeholder: kind === 'answer' ? 'Odpověď (např. 1 = povolit, nebo text)…' : 'Pokyn od orchestrátora…' }) as HTMLInputElement;
    const go = () => { send(input.value); saying = undefined; render(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    setTimeout(() => input.focus(), 0);
    return h('div.say', {}, input, h('button.sbtn.sm.go', { type: 'button', onclick: go }, 'Poslat'));
  }

  function assignBox(r: BoardRow): HTMLElement {
    const sel = h('select', { 'aria-label': 'Karta Opory' }, h('option', { value: '' }, '— bez karty —'),
      ...store.opora.cards.map((c) => h('option', { value: c.id, selected: c.id === r.group }, `${c.name}${c.sectorName ? ` · ${c.sectorName}` : ''}`))) as HTMLSelectElement;
    return h('div.say', {}, sel, h('button.sbtn.sm.go', { type: 'button', onclick: () => { if (workerId) deps.net.send({ t: 'sessions.assign', workerId, cardId: sel.value || null }); saying = undefined; toast('🗂️ Relace přiřazena'); } }, 'Přiřadit'));
  }

  function render() {
    const r = find();
    if (!r) { main.replaceChildren(h('p.note', {}, 'Relace tu už není.')); return; }
    const card = store.opora.cards.find((c) => c.id === r.group);
    const groupName = card?.name ?? (r.group === 'ctrl' ? 'Řízení a kontrola' : r.group === 'off' ? 'Mimo plán – bez karty Opory' : r.group);
    head.className = `m-h sst sst-${r.st}`;
    head.innerHTML = `<span class="av" style="background:${esc(r.color)}">${esc(r.name[0] ?? '?')}</span><h3>${esc(r.name)} · ${esc(r.task)}</h3>${statusPill(r)}<span class="path">${esc(groupName)}${card?.sectorName ? ` · ${esc(card.sectorName)}` : ''}${r.assigned ? ' · přiřazeno ručně' : ''}</span>`;
    if (!head.querySelector('.close')) head.append(h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => modal.close() }, '✕'));

    const waiting = r.st === 'human' || r.st === 'block';
    const recap = h('div', { class: `recap${waiting ? ' need' : ''}`, 'data-src': 'n' });
    if (waiting) {
      recap.innerHTML = `<span class="k">Potřebuje tě <i class="src n">N</i></span><b>${esc(r.need || 'Čeká na odpověď v terminálu.')}</b><span>Relace stojí ${r.ago} min. Poslední krok: ${esc(r.last)}.</span>`;
      const acts = h('div.acts', {},
        h('button.sbtn.sm.go', { type: 'button', disabled: !workerId || r.st === 'block', onclick: () => { saying = 'answer'; render(); } }, 'Odpovědět'),
        h('button.sbtn.sm', { type: 'button', disabled: !workerId, onclick: () => { closeAllModals(); if (workerId) deps.answerWorker(workerId); } }, 'Otevřít terminál'),
        h('button.sbtn.sm', { type: 'button', onclick: () => { deps.net.send({ t: 'chat', text: `🙋 ${r.name} potřebuje člověka (${r.task}): ${r.need || 'čeká v terminálu'}` }); toast('🙋 Předáno do chatu patra'); } }, 'Předat člověku'));
      recap.append(acts);
      if (saying === 'answer') recap.append(sayBox('answer'));
    } else {
      recap.innerHTML = `<span class="k">Souhrn posledního tahu <i class="src n">N</i></span><span>${esc(r.recap || r.sum || 'Relace zatím nic nenapsala.')} Teď: ${esc(r.last)} (${agoTxt(r.ago)}).${r.stale ? ' <b style="color:#c2512a">Bez pohybu – možná slepá ulička.</b>' : ''}</span>`;
    }
    const todo = h('ul.todo', { 'data-src': 'n' });
    const cur = r.todos.findIndex((t) => t.status === 'in_progress');
    const nextTicked = new Set<string>();
    r.todos.forEach((t, i) => {
      const done = t.status === 'completed';
      if (done) nextTicked.add(t.text);
      const li = h('li', { class: `${done ? 'on' : i === cur || (cur < 0 && i === r.plan[0] && r.st === 'run') ? 'cur' : ''}${done && !ticked.has(t.text) && ticked.size ? ' ticked' : ''}` }, h('i', {}, done ? '✓' : ''), t.text);
      todo.append(li);
    });
    ticked = nextTicked;
    if (!r.todos.length) todo.append(h('li', {}, h('i'), 'Bez plánu – relace si nevede seznam úkolů (TodoWrite).'));
    const kids = r.kids.length ? h('ul.todo', { 'data-src': 'n' }, ...r.kids.map((k) => h('li', { class: `kidrow ${k.state === 'run' ? 'cur' : 'on'}`, style: 'text-decoration:none' }, h('i', {}, k.state === 'done' ? '↑' : k.state === 'fail' ? '✕' : ''), `${k.kind === 'btw' ? '/btw ' : ''}${k.name} — ${k.state === 'run' ? k.last || 'pracuje' : k.report || ''}`))) : null;
    main.replaceChildren(recap, h('div.k', {}, `Živý plán relace · ${r.plan[0]}/${r.plan[1]} `, h('i.src.n', {}, 'N')), todo,
      ...(kids ? [h('div.k', {}, 'Pod-relace a /btw ', h('i.src.n', {}, 'N')), kids] : []));

    const w = workerId ? store.workers.get(workerId) : undefined;
    const kv = (k: string, src: string, rows: [string, string][], extra?: HTMLElement) => {
      const box = h('div.kv', { 'data-src': src }, h('div.k', {}, `${k} `, h(`i.src.${src}`, {}, src.toUpperCase())));
      if (extra) box.append(extra);
      for (const [a, b] of rows) box.append(h('div.r', {}, h('span', {}, a), h('b', {}, b)));
      return box;
    };
    const files = h('div.files');
    if (!r.worktree) files.append(h('div', {}, 'Bez worktree – pracuje ve sdíleném checkoutu.'));
    else if (!changes) files.append(h('div', {}, 'Načítám změny…'));
    else if (!changes.files.length) files.append(h('div', {}, `Bez změn${changes.ahead ? ` · ${changes.ahead} commitů` : ''}`));
    else for (const f of changes.files.slice(0, 8)) files.append(h('div', { class: f.status === 'A' || f.status === '?' ? 'a' : f.status === 'D' ? 'd' : 'm' }, `${f.status === '?' ? 'A' : f.status} ${f.path} ${f.binary ? '' : `+${f.additions} −${f.deletions}`}`));
    if (changes && changes.files.length > 8) files.append(h('div', {}, `… a dalších ${changes.files.length - 8 + changes.more}`));
    const ctx = r.ctx !== undefined ? h('div.ctx', {}, h('i', { class: r.ctx > 80 ? 'hot' : '', style: `width:${r.ctx}%` })) : undefined;
    side.replaceChildren(
      kv('Kde běží', 'd', [['Stůl', r.desk], ['Worktree', r.worktree ?? '—'], ['Větev', r.branch ?? '—'], ['Model', r.model ?? '—']]),
      kv('Kontext', 'n', [['Zaplněno', r.ctx !== undefined ? `${r.ctx} %` : 'neznámé']], ctx),
      kv('Změny', 'o', [], files),
      kv('Útrata a PR', 'd', [['Cena', r.cost ? money(r.cost) : '—'], ['Tokeny', tok(r.tokens)], ['PR', r.pr ? `#${r.pr.n} · ${r.pr.ck}${r.pr.s === 'merged' ? ' · sloučen' : ''}` : '—']]),
    );

    // The card's PR Lens, kept across redraws.
    const cardId = card?.id;
    if (cardId && store.floor) {
      if (lens?.card !== cardId) {
        lens?.s.destroy();
        lens = { card: cardId, s: new LensSection(store.floor, cardId, () => store.opora.cards.find((c) => c.id === cardId)?.sectorId, () => store.opora.url || undefined) };
        lensBox.replaceChildren(h('div.k', {}, `PR Lens karty „${card.name}“ `, h('i.src.d', {}, 'D')), lens.s.root);
      }
      lens.s.refresh();
    } else if (!lensBox.firstChild || lens) {
      lens?.s.destroy();
      lens = undefined;
      lensBox.replaceChildren(h('p.note', {}, 'PR Lens: relace nemá kartu Opory, ke které by patřil. Přiřaď ji kartě níže.'));
    }

    orch.replaceChildren(h('span.k', { style: 'align-self:center' }, 'Orchestrátor:'),
      h('button.sbtn.sm', { type: 'button', disabled: !workerId, onclick: () => { saying = saying === 'instruct' ? undefined : 'instruct'; render(); } }, '💬 Poslat pokyn'),
      h('button.sbtn.sm', { type: 'button', disabled: !w || w.status !== 'working', onclick: () => { if (workerId) { deps.net.send({ t: 'term.input', workerId, data: '\x1b' }); toast('⏸ Relace zastavena (Esc)'); } } }, '⏸ Zastavit'),
      h('button.sbtn.sm', { type: 'button', disabled: !workerId, onclick: () => { saying = saying === 'assign' ? undefined : 'assign'; render(); } }, '🗂️ Přiřadit kartě'),
      h('button.sbtn.sm', { type: 'button', disabled: !workerId, onclick: () => { if (workerId && confirm(`Poslat ${r.name} domů? Worktree zůstane.`)) { deps.net.send({ t: 'worker.kill', workerId, cleanup: 'keep' }); modal.close(); } } }, '🏠 Poslat domů'),
      ...(saying === 'instruct' ? [sayBox('instruct')] : saying === 'assign' ? [assignBox(r)] : []));
  }

  const offChanges = deps.messages.on('changes', (m) => { if (m.state.workerId === workerId && !m.state.repo) { changes = m.state; later(); } });
  if (workerId && first.worktree) deps.net.send({ t: 'changes.watch', workerId });
  let frame = 0;
  const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const offs = (['workers', 'sessions', 'opora', 'process', 'pulls'] as const).map((t) => store.on(t, later));
  const modal = openModal(el, {
    doing: `🧭 čte relaci ${first.name}`,
    onClose: () => { offs.forEach((o) => o()); offChanges(); cancelAnimationFrame(frame); lens?.s.destroy(); if (workerId && first.worktree) deps.net.send({ t: 'changes.unwatch', workerId }); },
  });
  render();
  return modal;
}
