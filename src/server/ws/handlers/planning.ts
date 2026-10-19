// The planning room: asking for a plan, handing its tasks to the queue, stopping it, and clearing the room.
import { isAgentEffort, isAgentProvider, type PlanningClientMsg } from '../../../shared/protocol.js';
import { PLAN_LIMITS } from '../../../shared/planning.js';
import { OPEN_CODE_MODEL_MAX } from '../../../shared/providers.js';
import { str } from '../../office/input.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const planningView: ViewPieces['planning'] = (_ctx, floor) => floor?.planning.state() ?? { current: null, past: [] };

export const planningHandlers = {
  'planning.start'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    if (!floor) return;
    if (msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) {
      ctx.warn(c, 'Unknown agent provider');
      return;
    }
    const request = {
      goal: str(msg.goal, PLAN_LIMITS.goal),
      title: str(msg.title, 200) || undefined,
      mode: msg.mode === 'opora' || msg.mode === 'router' ? msg.mode : ('file' as const),
      provider: msg.provider,
      model: msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1),
      effort: isAgentEffort(msg.effort) ? msg.effort : undefined,
    };
    // The planner, and later the tasks it queues, run on the sign-ins of whoever asked for the plan.
    ctx.withSignIn(c, ctx.claudeFor(request.provider ?? floor.workers.officeDefault.provider), () => ctx.warn(c, floor.planning.start(request, who, c.accountId)));
  },
  'planning.queue'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    if (!floor) return;
    const tasks = Array.isArray(msg.tasks) ? msg.tasks.slice(0, PLAN_LIMITS.tasks).filter((i): i is number => Number.isInteger(i)) : [];
    const plan = floor.planning.state().current;
    ctx.withSignIn(c, ctx.claudeFor(plan?.provider ?? floor.workers.officeDefault.provider), () => {
      const r = floor.planning.queueTasks(tasks, who);
      if (typeof r === 'string') ctx.warn(c, r);
    });
  },
  'planning.stop'(ctx, c) {
    const floor = here(ctx, c);
    if (floor) ctx.warn(c, floor.planning.stop(c.peer.name));
  },
  'planning.clear'(ctx, c) {
    const floor = here(ctx, c);
    if (floor) ctx.warn(c, floor.planning.clear(c.peer.name));
  },
} satisfies HandlerMap<PlanningClientMsg>;
