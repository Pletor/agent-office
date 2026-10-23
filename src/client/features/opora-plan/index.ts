import type { Ctx } from '../../core/context';
import { listenForLensEsc } from '../lens/diagram';
import { addWindowTab } from '../process-wall/ui';
import { OporaPlanTab } from './tab';

/**
 * "Lens plánu", a tab of the process wall's window: the plan Lens of the floor's whole Opora project,
 * and every card of it to pick, each opening the inspector's sections (Lens, Jak to bude vypadat)
 * whether a worker runs it or not. Read-only, like the rest of the window.
 */
export function installOporaPlan(_ctx: Ctx) {
  listenForLensEsc();
  addWindowTab({ id: 'opora-plan', label: 'Lens plánu', open: () => new OporaPlanTab() });
}
