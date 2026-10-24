// Workers stopped on their provider's usage limit, for the board's "Stav agentů" tab: something the
// system is waiting out, not a request for the boss (see shared/usage-limit.ts).
import type { WorkerInfo } from '../../../shared/protocol';
import { pauseCz } from '../../../shared/usage-limit';
import { h } from '../../ui/dom';

/** The floor's workers paused on a usage limit. */
export function pausedWorkers(workers: Iterable<WorkerInfo>): WorkerInfo[] {
  return [...workers].filter((w) => !!w.paused);
}

export function pausedCard(worker: WorkerInfo, open: () => void): HTMLElement {
  const p = worker.paused!;
  return h('article.boss-attention-item', { 'data-kind': 'system' }, h('span.boss-attention-tag', {}, 'Pouze informace — není to tvůj úkol'),
    h('h4', {}, `${worker.name}: ${pauseCz(p)}`),
    h('p', {}, `Poskytovatel agenta zastavil práci na limitu (${p.kind}). Hlášení v terminálu: „${p.line}“.`),
    h('p.boss-attention-owner', {}, h('b', {}, 'Odpovědnost: '), 'Poskytovatel agenta — limit předplatného'),
    h('p', {}, h('b', {}, 'Stav: '), p.resetsAt ? 'Worker stojí, dokud se limit neobnoví; potom obvykle pokračuje sám.' : 'Worker stojí; čas obnovení poskytovatel neuvedl nebo ho kancelář nepřečetla.'),
    h('p.boss-attention-action', {}, 'Tvoje akce nyní: žádná. Tabule nic nespouští.'),
    h('p', {}, h('b', {}, 'Oprávnění v Opoře: '), 'Běh bez pevného termínu, nebo s obnovením limitu před termínem, kancelář drží dál. Jinak ho uvolnila a worktree ponechala (viz Živý proces).'),
    h('p.boss-attention-result', {}, h('b', {}, 'Co se stane potom: '), 'Položka zmizí, jakmile worker znovu pracuje. Pokud ani po obnovení limitu nepokračuje, otevři jeho terminál.'),
    h('button.btn', { type: 'button', 'data-attention-key': `pause:${worker.id}`, onclick: open }, 'Otevřít terminál (jen náhled)'));
}
