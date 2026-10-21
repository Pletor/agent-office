import type { ExecutionBudget } from '../execution-budget.js';

export const PROVIDER = 'anthropic-managed-agents' as const;
/** Broker-private immutable authority. Contains no lease token or provider credentials. */
export interface ExecutionIntent {
  intentId: string; requestId: string; provider: typeof PROVIDER;
  project: string; workspace: string; nodeId: string; executionId: string; epoch: number;
  acceptedRevision: string; assignmentDigest: string; contextProtocolVersion: 1 | 2; contextVersion: string;
  executionProtocolVersion: 2; budget: ExecutionBudget; authorityDeadlineAt: number;
  repository: { url: string; commitSha: string };
  agentId: string; agentVersion: number;
  environmentId: string; environmentDigest: string; configurationDigest: string; maxListCostCents: string;
}
export type ProviderStatus = 'idle' | 'running' | 'rescheduling' | 'terminated';
export interface ProviderObservation {
  intentId: string; executionId: string; epoch: number; sessionId: string; observedAt: number;
  status: ProviderStatus; inputTokens: number; outputTokens: number; cacheReadInputTokens: number;
  cacheCreation5mTokens: number; cacheCreation1hTokens: number; listCostCents: string;
  currency: 'USD'; activeSeconds: number; source: 'provider-api'; digest: string;
}
export type ExecutorState = 'intent' | 'creating' | 'creation_unknown' | 'mapped' | 'starting' | 'running' | 'termination_pending' | 'terminated';
export interface ExecutionRecord {
  intent: ExecutionIntent; state: ExecutorState; sessionId: string | null; observation: ProviderObservation | null;
}
export interface ExecutorStatus {
  intentId: string; executionId: string; epoch: number; state: ExecutorState; sessionId: string | null;
  observation: ProviderObservation | null;
}
export interface ExecutorRequirements { isolation: true; invoiceHardLimit?: boolean; exactTerminationDeadline?: boolean }
export interface RemoteExecutor {
  readonly provider: typeof PROVIDER;
  available(requirements: ExecutorRequirements): Promise<boolean>;
  start(intent: ExecutionIntent, prompt: string, revalidate: () => Promise<boolean>): Promise<ExecutorStatus>;
  observe(intentId: string): Promise<ExecutorStatus>;
  revoke(intentId: string): Promise<ExecutorStatus>;
  reconcile(intentId: string): Promise<ExecutorStatus>;
  status(intentId: string): ExecutorStatus;
}
export class ExecutorUnavailable extends Error { constructor() { super('Isolated executor unavailable or unsupported'); } }
export class ExecutorFailure extends Error { constructor() { super('Isolated executor operation could not be verified'); } }
