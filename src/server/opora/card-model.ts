import { isAgentEffort, type AgentEffort } from '../../shared/providers.js';

/** The model, effort and advisor a card's worker starts on (Opora brain-heart-orchestrator §12, O10). */
export interface CardModel { model: string; effort: AgentEffort; advisor?: string }

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

/** The fields of a worker the card's choice may fill. */
export interface CardModelTarget { provider?: string; model?: string; effort?: AgentEffort; advisor?: string }

/**
 * Fills `target` from `choice` for a Claude worker only, and only what nobody chose: a model or effort a person
 * picked (or set as the floor's default) stays, and then the card's advisor is not added to it.
 */
export function fillCardModel(target: CardModelTarget, choice: CardModel): void {
  if (target.provider !== 'claude') return;
  const modelFree = target.model === undefined;
  target.model ??= choice.model;
  target.effort ??= choice.effort;
  if (modelFree && choice.advisor) target.advisor = choice.advisor;
}
