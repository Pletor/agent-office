import type { OporaState } from '../../../shared/protocol';
import { OPORA_TAB } from '../../../shared/opora';
import { h } from '../../ui/dom';
import { oporaPageUrl } from './full';

const REASONS: Record<string, string> = {
  no_accepted_baseline: 'no accepted baseline',
  baseline_awaiting_human: 'baseline awaiting a person',
};

/** "57 cards", "57+ cards" when Canvas cut its list short. */
const cards = (n: number, more?: boolean) => `${n}${more ? '+' : ''} card${n === 1 && !more ? '' : 's'}`;

/** The 🛰️ window's line for what waits on a person in Opora, or null when nothing does. */
export function humanWaitNotice(s: OporaState): HTMLElement | null {
  const w = s.humanWait;
  if (!w || !w.decisions.length) return null;
  const titles = w.decisions.map((d) => d.title).join(', ');
  const held = w.claimsBlocked
    ? `until then nobody can take any card${w.cards ? ` (${cards(w.cards, w.more)} held back)` : ''}`
    : w.cards ? `${cards(w.cards, w.more)} wait on it` : 'the plan waits on it';
  const stages = w.stages.map((x) => `${x.id}: ${REASONS[x.reason] ?? x.reason.replace(/_/g, ' ')}${x.count ? ` (${x.count})` : ''}`).join(' · ');
  return h(
    'div.opora-human-wait',
    { role: 'status' },
    h('p', {}, h('b', {}, '⏸️ Opora waits on a person: '), titles, ` — ${held}.`),
    stages ? h('p.muted', {}, stages) : null,
    h('a.btn.small.primary', { href: oporaPageUrl(s), target: OPORA_TAB, rel: 'noopener noreferrer', title: 'Only a person can decide this, in Opora' }, '↗ Decide in Opora'),
  );
}
