// What every tab of the window gets, and the small DOM pieces they share.

import type { ProcessEvent } from '../../../shared/protocol';
import { h } from '../../ui/dom';
import { markOf, PHASE_CZ, phaseIndex, type Board, type Mark } from './lanes';
import type { SourceHealth } from './live';

export interface PanelData {
  board: Board;
  /** The floor's journal, oldest first. */
  events: readonly ProcessEvent[];
  health: SourceHealth[];
  floor: string;
  reduced: boolean;
}

export interface Tab {
  readonly root: HTMLElement;
  update(data: PanelData): void;
  destroy?(): void;
}

export const clock = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
};

/** A trail dot (or a skipped one). */
export const trailEl = (mark: Mark | 'skip', extra = '') => h('span', { class: `pw-tr ${mark} ${extra}`.trim(), 'aria-hidden': 'true' });

export const eventMark = (e: ProcessEvent) => trailEl(markOf(e.state));

/** The numbered phase pill of the event stream. */
export function phasePill(phase: string) {
  const i = phaseIndex(phase);
  return h('span.pw-phpill', {}, h('span.n', {}, i + 1), PHASE_CZ[i]);
}

/** A GitHub PR link only for a plain https github.com address; anything else stays text. */
export function safeGithub(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}
