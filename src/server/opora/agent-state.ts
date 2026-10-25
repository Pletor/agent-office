// Reading Canvas's agent-state (GET /api/oporahub/agent-state) once per poll: the cards it offers a
// ready claim for, and a small digest of what waits on a person there (docs/opora-execution.md).

import type { OporaHumanWait } from '../../shared/protocol/opora.js';
import { contextVersionFromEnvironment, type ContextVersion } from './execution-context.js';

/** What one agent-state read gives the bridge. */
export interface AgentStateDigest {
  /** The cards with a ready `claim` action (accepted plan steps, budget, no unfinished predecessor). */
  ready: Set<string>;
  /** What waits on a person, or undefined when nothing does (or Canvas didn't say). */
  humanWait?: OporaHumanWait;
}

/** Bounds on what goes onto the floor's state, whatever Canvas sends. */
export const HUMAN_WAIT_LIMITS = { decisions: 4, stages: 6, text: 160 } as const;

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec).filter((r): r is Record<string, unknown> => !!r) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, HUMAN_WAIT_LIMITS.text) : '');

/**
 * Digests an agent-state document. Anything missing or malformed counts as "nothing said", never as
 * an error: an older Canvas without stages or decisions just has no human wait. A human wait is a
 * decision whose action Canvas marks `human_only`; the stages that block or wait come along with it,
 * and the cards Canvas holds back for those stages' reasons are counted (a lower bound when Canvas
 * cut its card list short). Claims are blocked outright while there's no accepted baseline. A claim whose
 * preconditions ask for context protocol 2 (a card with a pinned Harness kit) is ready only for a v2 office.
 */
export function digestAgentState(doc: unknown, contextVersion: ContextVersion = contextVersionFromEnvironment()): AgentStateDigest {
  const d = rec(doc) ?? {};
  const actions = rows(d.actions);
  const needsV2 = (a: Record<string, unknown>) => rec(a.preconditions)?.contextProtocolVersion === 2;
  const ready = new Set(actions.filter((a) => a.verb === 'claim' && a.status === 'ready' && typeof a.targetId === 'string'
    && (contextVersion === 2 || !needsV2(a))).map((a) => a.targetId as string));
  const humanOnly = new Set(actions.filter((a) => a.blockReason === 'human_only' && typeof a.id === 'string').map((a) => a.id as string));
  const decisions = rows(d.decisions)
    .filter((x) => typeof x.actionId === 'string' && humanOnly.has(x.actionId) && text(x.kind))
    .map((x) => ({ kind: text(x.kind), title: text(x.title) || text(x.kind) }));
  if (!decisions.length) return { ready };
  const stages = rows(d.stages)
    .filter((s) => (s.health === 'blocking' || s.health === 'waiting') && text(s.id))
    .map((s) => ({ id: text(s.id), health: s.health as 'blocking' | 'waiting', reason: text(s.reason), count: typeof s.count === 'number' && Number.isFinite(s.count) ? Math.max(0, Math.floor(s.count)) : 0 }));
  const reasons = new Set(stages.map((s) => s.reason).filter(Boolean));
  const cards = rows(d.cards).filter((c) => (c.health === 'blocking' || c.health === 'waiting') && typeof c.reason === 'string' && reasons.has(c.reason)).length;
  const noBaseline = decisions.some((x) => x.kind === 'accept_baseline') || stages.some((s) => s.health === 'blocking' && s.reason === 'no_accepted_baseline');
  return {
    ready,
    humanWait: {
      decisions: decisions.slice(0, HUMAN_WAIT_LIMITS.decisions),
      stages: stages.slice(0, HUMAN_WAIT_LIMITS.stages),
      cards,
      ...(d.truncated === true ? { more: true } : {}),
      claimsBlocked: noBaseline && ready.size === 0,
    },
  };
}

/** The decisions' titles in one line, for a toast or a refusal. */
export function waitTitles(w: OporaHumanWait): string {
  return w.decisions.map((x) => `“${x.title}”`).join(', ');
}

/** Why no card can be taken now, or undefined when claims aren't blocked on a person. */
export function claimsBlockedReason(w: OporaHumanWait | undefined): string | undefined {
  if (!w?.claimsBlocked) return undefined;
  return `Opora waits on a person: ${waitTitles(w)}. No card can be taken until it's decided in Opora`;
}

/**
 * Says once that the autopilot and the hand-out hold off while claims wait on a person, instead of
 * trying each card and failing at claim every poll. It speaks again only once the wait changes.
 */
export class HumanWaitNotice {
  private said = new Set<string>();

  constructor(private toast: (text: string) => void) {}

  /** Whether to hold off: true while claims are blocked on a person (toasting the first time). */
  holds(w: OporaHumanWait | undefined, who: string): boolean {
    const why = claimsBlockedReason(w);
    if (!why) {
      this.said.clear();
      return false;
    }
    const key = `${who}:${why}`;
    if (!this.said.has(key)) {
      this.said.add(key);
      this.toast(`${who} holds off: ${why}`);
    }
    return true;
  }
}
