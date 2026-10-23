// What the orchestrator mustn't lose on the third screen: dead ends (tests failing over and over, done
// without a PR, a session that fell asleep, no move for a while), orphans and work outside the plan (a
// card whose session went home while its lease holds, a session with no card, worktrees left behind),
// who waits on a person or on another card, and the follow-up work to start (what sessions suggested,
// and the cards Opora offers next). Pure, from the board (sessions-board.ts).

import type { OporaCard, OporaRun, QueueTask } from './protocol.js';
import { CTRL, OFFPLAN, type Board, type BoardRow } from './sessions-board.js';

export interface AttItem {
  /** The row it's about, to open its detail. */
  row?: string;
  title: string;
  tag: string;
  why: string;
}

export type Launch = { kind: 'queue'; title: string; prompt: string } | { kind: 'take'; cardId: string };

export interface FollowItem {
  key: string;
  title: string;
  why: string;
  launch: Launch;
}

export interface Attention {
  dead: AttItem[];
  orph: AttItem[];
  hum: AttItem[];
  fol: FollowItem[];
}

/** A worktree or branch the floor's clean line says was left behind (cleanline's HealthFlag). */
export interface LeftBehind {
  kind: string;
  text: string;
  where?: string;
}

export interface AttentionInput {
  cards: OporaCard[];
  runs: OporaRun[];
  tasks: Pick<QueueTask, 'title' | 'status'>[];
  health?: LeftBehind[];
  now: number;
}

const ago = (m: number) => (m <= 0 ? 'teď' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const cardName = (b: Board, id: string) => b.groups.find((g) => g.id === id)?.name ?? id;

export function attention(b: Board, i: AttentionInput): Attention {
  const a: Attention = { dead: [], orph: [], hum: [], fol: [] };
  const item = (r: BoardRow, tag: string, why: string): AttItem => ({ row: r.id, title: `${r.name} · ${r.task}`, tag, why });
  for (const r of b.rows) {
    const f = r.flags;
    if (f.includes('failing')) a.dead.push(item(r, ago(r.ago), 'Testy nebo build padají pořád stejně – relace se točí v kruhu. Návrh: zastavit a poslat pokyn s hypotézou.'));
    else if (f.includes('nopr')) a.dead.push(item(r, ago(r.ago), 'Hotovo bez PR – práce ve worktree se může ztratit. Návrh: otevřít PR z worktree.'));
    else if (r.st === 'sleep' && f.includes('stale')) a.dead.push(item(r, ago(r.ago), `Relace skončila a nikdo ji neprobudil${r.group !== OFFPLAN && r.group !== CTRL ? `, karta „${cardName(b, r.group)}“ na ni počítá` : ''}. Návrh: probudit (R), nebo předat.`));
    else if (f.includes('stalekid')) a.dead.push(item(r, ago(r.ago), 'Pod-relace běží dlouho bez pohybu. Návrh: zkontrolovat, jestli nečeká naprázdno.'));
    else if (f.includes('stale') && r.st === 'run') a.dead.push(item(r, ago(r.ago), `Bez pohybu ${ago(r.ago)} – v žurnálu ani v přepisu se nic neděje. Návrh: podívat se do terminálu.`));
    if (f.includes('orphan-card')) a.orph.push(item(r, 'karta', `Karta „${cardName(b, r.group)}“ drží zámek${r.leaseUntil ? ` do ${new Date(r.leaseUntil).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}` : ''}, ale relace odešla. Návrh: uvolnit zámek, nebo usadit nový stůl.`));
    if (f.includes('offplan') && (r.st === 'run' || r.st === 'human')) a.orph.push(item(r, 'mimo plán', 'Běží bez karty Opory – možná nežádoucí práce. Návrh: přiřadit kartě, nebo zastavit.'));
    else if (f.includes('offplan') && (r.st === 'idle' || r.st === 'done' || r.st === 'sleep')) a.orph.push(item(r, ago(r.ago), 'Stůl bez karty, nic nedělá. Návrh: přiřadit kartě, nebo poslat domů.'));
    if (r.st === 'human') a.hum.push(item(r, ago(r.ago), r.need || 'Čeká na odpověď v terminálu.'));
    if (r.st === 'block') a.hum.push(item(r, 'blokováno', r.need || 'Čeká na jinou kartu.'));
  }
  for (const h of i.health ?? []) {
    if (h.kind !== 'orphan-worktree' && h.kind !== 'merged-not-deleted') continue;
    a.orph.push({ title: h.where || (h.kind === 'orphan-worktree' ? 'worktree' : 'větev'), tag: h.kind === 'orphan-worktree' ? 'worktree' : 'větev', why: h.text });
  }

  const queued = new Set(i.tasks.map((t) => t.title.trim().toLowerCase()));
  for (const r of b.rows) {
    r.follow.forEach((t, n) => {
      if (queued.has(t.trim().toLowerCase())) return;
      const card = r.group !== OFFPLAN && r.group !== CTRL ? cardName(b, r.group) : undefined;
      a.fol.push({
        key: `${r.id}:${n}`, title: t, why: `navrhl(a) ${r.name}${card ? ` po kartě „${card}“` : ` po úkolu „${r.task}“`}`,
        launch: { kind: 'queue', title: t, prompt: `${t}\n\nNavazuje na práci ${r.name} (${r.task})${card ? ` u karty Opory „${card}“` : ''}${r.branch ? `, větev ${r.branch}` : ''}.` },
      });
    });
  }
  const taken = new Set(i.runs.filter((r) => r.state !== 'gone').map((r) => r.cardId));
  for (const c of i.cards.filter((c) => c.status === 'frontier' && c.ready && !taken.has(c.id)).slice(0, 4)) {
    a.fol.push({ key: `card:${c.id}`, title: `Vzít kartu „${c.name}“`, why: `Opora ji nabízí jako další na řadě${c.sectorName ? ` (${c.sectorName})` : ''} – nikdo z kanceláře na ní není`, launch: { kind: 'take', cardId: c.id } });
  }
  return a;
}
