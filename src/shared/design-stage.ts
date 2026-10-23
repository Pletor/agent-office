// Shared, so the office server can tell the orchestrator where a design card is, the same way the window does.
// Where a design card is, as seven stages (Zadání, Skica, Pohyb, Kód, Kontroly, Review, Hotovo), and
// what evidence it has, from what the office knows: the card on Opora's canvas (status, stage on
// turn), its lane on the process wall (phase, branch, PR) and its preview (sketch, storyboard,
// screenshots per head, confirmation). Pure, so the tests read the same thing the window shows.

import type { OporaPreviewReply, PreviewHead } from './opora-preview.js';

export const STAGES = [
  { short: 'Zadání', what: 'Zadání' },
  { short: 'Skica', what: 'Skica obrazovky' },
  { short: 'Pohyb', what: 'Storyboard' },
  { short: 'Kód', what: 'Rozpracovaný náhled' },
  { short: 'Kontroly', what: 'Screenshoty' },
  { short: 'Review', what: 'Shoda s návrhem · před / po' },
  { short: 'Hotovo', what: 'Výsledek' },
] as const;

export interface StageInput {
  /** The card's status on the canvas (`closed`…) and the stage on turn (`Shoda s návrhem`…). */
  status?: string;
  stage?: string;
  /** The lane's phase (PROCESS_PHASES index) and whether any event moved it. */
  phase: number;
  moved: boolean;
  branch?: string;
  pr?: number;
  working: boolean;
  preview?: OporaPreviewReply;
}

/** The head the window shows: the current one, or the newest. */
export const shownHead = (r?: OporaPreviewReply): PreviewHead | undefined => r?.heads.find((x) => x.current) ?? r?.heads[0];

const REVIEW = /shoda|review|kritik|revize|recenz/i;

/** The stage index 0–6. */
export function designStage(s: StageInput): number {
  const p = s.preview, head = shownHead(p);
  if (s.status === 'closed' || head?.confirmed || (s.moved && s.phase >= 5)) return 6;
  if ((s.stage && REVIEW.test(s.stage)) || (s.moved && s.phase === 4)) return 5;
  if (head?.shots.length || (s.moved && s.phase === 3)) return 4;
  if (s.branch || s.pr || s.working || head || (s.moved && s.phase === 2) || s.status === 'claimed') return 3;
  if (p?.storyboard?.moments) return 2;
  if (p?.sketch || p?.drawing) return 1;
  return 0;
}

/** full: proven; human: confirmed by a person; half: claimed or partial; none: not there yet. */
export type EvidenceState = 'full' | 'human' | 'half' | 'none';
export interface Evidence { name: string; state: EvidenceState; note?: string }

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');

export function evidence(s: StageInput, stage: number): Evidence[] {
  const p = s.preview, head = shownHead(p);
  const els = p?.drawing?.elements, moments = p?.storyboard?.moments;
  const pr = head?.prNumber ?? s.pr;
  const out: Evidence[] = [
    { name: 'Skica', state: p?.sketch || els ? 'full' : 'none', note: els ? `${els} prvků` : p?.sketch ? 'SVG' : undefined },
    { name: 'Storyboard', state: moments ? 'full' : 'none', note: moments ? `${moments} momentů` : undefined },
    { name: 'Kód existuje', state: pr ? 'full' : s.branch ? 'half' : 'none', note: pr ? `PR #${pr}` : s.branch ? 'větev, bez PR' : undefined },
    { name: 'Screenshoty', state: head?.shots.length ? (head.current ? 'full' : 'half') : 'none',
      note: head?.shots.length ? `${head.shots.length}${head.headSha ? ` · ${short(head.headSha)}` : ''}${head.current ? '' : ' · starší head'}` : undefined },
    { name: 'Shoda s návrhem', state: head?.confirmed ? 'full' : stage >= 5 ? 'half' : 'none', note: head?.confirmed ? 'doloženo' : stage >= 5 ? 'hlásí agent' : undefined },
  ];
  if (p?.mode === 'explore') {
    out.push({ name: 'Nový směr', state: head?.proposed ? 'half' : stage >= 1 ? 'half' : 'none', note: head?.proposed ? 'návrh DESIGN.md' : 'experiment' });
  } else {
    const ds = p?.designSystem;
    const match = !!(head?.designMdSha256 && ds?.sha256 && head.designMdSha256 === ds.sha256);
    out.push({ name: 'Soulad s brandem', state: !head?.shots.length ? 'none' : match ? 'full' : 'half',
      note: !head?.shots.length ? undefined : match ? 'podle DESIGN.md' : head.designMdSha256 ? 'starší DESIGN.md' : 'bez DESIGN.md' });
  }
  out.push({ name: 'Potvrzeno člověkem', state: head?.confirmed ? 'human' : 'none', note: head?.confirmed ? 'člověk' : undefined });
  return out;
}
