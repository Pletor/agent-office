import { ExecutionClient, validateExecution, type ExecutionClaim, type ExecutionLease } from './execution-client.js';
import type { ContextVersion } from './execution-context.js';
import { EXECUTION_TTL } from './execution-controller.js';
import type { IsolatedRun, IsolatedStore } from './isolated-storage.js';

/** Persist the exact request before the claim; capture valid received authority before validation can reject it. */
export async function isolatedClaim(store: IsolatedStore, key: string, version: ContextVersion,
  agent: string, transport: typeof fetch, active: () => void) {
  let received: ExecutionLease | undefined;
  let run = store.read(key)!;
  const scope = { project: run.project, workspace: run.workspace, nodeId: run.input.cardId };
  const guarded: typeof fetch = async (url, init) => {
    active();
    const response = await transport(url, init);
    if (new URL(String(url)).pathname.endsWith('/claim') && response.ok) {
      const copy = response.clone(), text = await copy.text();
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Canvas authority too large');
      try { received = validateExecution(JSON.parse(text), scope); }
      catch { throw new Error('Canvas authority invalid'); }
      run = store.read(key)!; store.save({ ...run, lease: received });
    }
    return response;
  };
  const client = new ExecutionClient(run.base, agent, guarded);
  try {
    if (!run.claim) {
      active();
      const context = await client.context(scope, version);
      if (!context.available || !context.acceptedHead || !context.contextVersion || context.executionProtocolVersion !== 2
        || !context.budget?.enrolled || !context.budget.policyHead || context.budget.blockedReason) throw new Error('Budgeted Canvas authority unavailable');
      const claim: ExecutionClaim = { ...scope, expectedAcceptedHead: context.acceptedHead, expectedContextVersion: context.contextVersion,
        expectedBudgetPolicyHead: context.budget.policyHead, previousExecutionId: context.budget.latestExecutionId,
        requestId: 'isolated-' + key, ttlSeconds: EXECUTION_TTL, ...(version === 2 ? { contextProtocolVersion: 2 as const } : {}) };
      run = store.read(key)!; store.save({ ...run, claim, stage: 'claiming' });
    }
    active();
    const lease = await client.claim(store.read(key)!.claim!);
    run = store.read(key)!; store.save({ ...run, lease, stage: 'claimed' });
    return lease;
  } catch {
    if (received) await new ExecutionClient(run.base, agent, transport).release(received).catch(() => {});
    throw new Error('Isolated Canvas claim unavailable or uncertain');
  }
}
