import type { BossAttentionItem } from '../../shared/boss-attention.js';
import { oporaCanvasUrl } from '../../shared/opora.js';
import type { OporaState } from '../../shared/protocol/opora.js';

/** Canvas's stage reasons in words; an unknown one is shown as Canvas wrote it. */
const REASONS: Record<string, string> = {
  no_accepted_baseline: 'chybí přijaté výchozí zadání',
  baseline_awaiting_human: 'výchozí zadání čeká na člověka',
};

/** "karta / karty / karet" for a count. */
export function cardsCs(n: number, more = false): string {
  const word = n === 1 ? 'karta' : n >= 2 && n <= 4 ? 'karty' : 'karet';
  return `${n}${more ? '+' : ''} ${word}`;
}

/**
 * The human-only decisions Opora's agent-state waits on (accepting the baseline, a changeset of plan
 * steps), as requests for the boss's decision: whole-workspace items, linking to the project in Opora.
 */
export function humanWaitItems(state: OporaState, path: string[]): BossAttentionItem[] {
  const w = state.humanWait;
  if (!w || !state.project || !state.workspace) return [];
  const stages = w.stages.map((s) => `${s.id}: ${REASONS[s.reason] ?? s.reason}${s.count ? ` (${s.count})` : ''}`);
  const held = w.cards ? `${cardsCs(w.cards, w.more)} do té doby nikdo nepřevezme` : 'práce na plánu do té doby stojí';
  return w.decisions.map((d) => ({
    id: `human-wait:${d.kind}`,
    title: d.title,
    path,
    kind: 'question',
    reason: `Opora čeká na člověka: ${d.title} — ${held}.`,
    action: 'Rozhodni v Opoře; agenti to za tebe udělat nemohou.',
    url: oporaCanvasUrl(state),
    guidance: {
      owner: 'Ty — rozhodnutí, které Opora dovolí jen člověku',
      activity: w.claimsBlocked ? 'Autopilot, rozdávání i ▶ Převzít v kanceláři stojí, dokud nerozhodneš.' : 'Čeká na tvoje rozhodnutí.',
      steps: [
        'Otevři projekt v Opoře tlačítkem níže.',
        `Najdi rozhodnutí „${d.title}“, projdi, co přijímáš, a rozhodni (přijmout, nebo vrátit k úpravě).`,
        'Po uložení v Opoře se vrať sem a stiskni „Obnovit“. Kancelář si stav načte při dalším čtení Opory (do 20 s).',
      ],
      expected: 'Po přijetí položka zmizí a karty, které na rozhodnutí čekaly, může kancelář převzít.',
      blockers: stages,
      linkLabel: 'Otevřít projekt v Opoře',
    },
  }));
}
