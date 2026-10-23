// The project's plan Lens for the process wall's "Lens plánu" tab (GET /api/opora-plan-lens): the plan
// of the floor's whole Opora project, without a card, read the same way as a card's area plan.
import type { PlanLens } from './opora-lens.js';

export interface OporaPlanReply {
  /** The floor is linked to an Opora project and workspace. */
  linked: boolean;
  /** Opora's address, for "Otevřít v Opoře". */
  base?: string;
  /** The linked project's name, for the heading. */
  project?: string;
  plan: PlanLens;
}
