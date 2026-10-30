import { isAgentEffort, isClaudeModel, type AgentEffort } from '../../shared/providers.js';
import type { OporaCardRun } from '../../shared/protocol/opora.js';
import { OPORA_NO_HANDOUT } from '../../shared/opora.js';

/**
 * The model, effort and advisor a card's worker starts on (Opora brain-heart-orchestrator §12, O10). `fromRun`: it is
 * the assignment's `run` (Opora metriky-a-spoustece §3), which wins over the floor's default; otherwise it only fills gaps.
 */
export interface CardModel { model: string; effort: AgentEffort; advisor?: string; fromRun?: true }

/** Why a card whose `run` says `handout: false` (label XL) is not handed to a worker. */
export const NO_HANDOUT_REASON = OPORA_NO_HANDOUT;

/** The run profile Opora pins in an assignment (`assignment.run`) and shows on a card (`gauge.run` in agent-state). */
export type CardRun = OporaCardRun;

/**
 * Reads a `run` object: undefined when it's absent or its effort isn't one the CLI takes (older runs have none). An
 * unknown model falls back to the O10 table's for the effort; an unknown or null advisor means none.
 */
export function readRun(raw: unknown): CardRun | undefined {
  const run = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!run || !isAgentEffort(run.effort)) return undefined;
  return {
    ...(typeof run.label === 'string' && run.label ? { label: run.label.slice(0, 8) } : {}),
    effort: run.effort,
    model: isClaudeModel(run.model) ? run.model : cardModel(run.effort).model,
    ...(isClaudeModel(run.advisor) ? { advisor: run.advisor } : {}),
    handout: run.handout !== false,
    humanReview: run.humanReview === true,
  };
}

/** The `run` of an Opora assignment (`assignment.run`, context v1 and v2). */
export function runOf(assignment: unknown): CardRun | undefined {
  return readRun((assignment as { run?: unknown } | null | undefined)?.run);
}

/** The `card.effort` of an Opora assignment (`specification.node.card.effort`); undefined when absent or unknown. */
export function cardEffortOf(assignment: unknown): AgentEffort | undefined {
  const spec = (assignment as { specification?: { node?: { card?: { effort?: unknown } } } } | null | undefined)?.specification;
  const effort = spec?.node?.card?.effort;
  return isAgentEffort(effort) ? effort : undefined;
}

/** low: sonnet/low; medium or missing: sonnet/medium + advisor opus; high, xhigh likewise; max: opus/high, no advisor. */
export function cardModel(effort: AgentEffort | undefined): CardModel {
  switch (effort) {
    case 'low': return { model: 'sonnet', effort: 'low' };
    case 'high': return { model: 'sonnet', effort: 'high', advisor: 'opus' };
    case 'xhigh': return { model: 'sonnet', effort: 'xhigh', advisor: 'opus' };
    case 'max': return { model: 'opus', effort: 'high' };
    default: return { model: 'sonnet', effort: 'medium', advisor: 'opus' };
  }
}

/** What a claimed card's worker starts on: its `run`, else the O10 table for its `card.effort`. */
export function assignmentModel(assignment: unknown): CardModel {
  const run = runOf(assignment);
  if (!run) return cardModel(cardEffortOf(assignment));
  return { model: run.model, effort: run.effort, ...(run.advisor ? { advisor: run.advisor } : {}), fromRun: true };
}

/** The fields of a worker the card's choice may fill. */
export interface CardModelTarget { provider?: string; model?: string; effort?: AgentEffort; advisor?: string }

/**
 * Fills `target` from `choice` for a Claude worker only. A choice from the card's `run` sets model, effort and advisor
 * over the floor's default. Without a `run` it fills only what nobody chose: a model or effort a person picked (or set
 * as the floor's default) stays, and then the card's advisor is not added to it.
 */
export function fillCardModel(target: CardModelTarget, choice: CardModel): void {
  if (target.provider !== 'claude') return;
  if (choice.fromRun) {
    target.model = choice.model;
    target.effort = choice.effort;
    if (choice.advisor) target.advisor = choice.advisor; else delete target.advisor;
    return;
  }
  const modelFree = target.model === undefined;
  target.model ??= choice.model;
  target.effort ??= choice.effort;
  if (modelFree && choice.advisor) target.advisor = choice.advisor;
}
