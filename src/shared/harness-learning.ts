/** Learning cohorts never mix resource revisions, runner versions, problems or scope ancestry. */
export interface HarnessCohort {
  resource: string;
  digest: string;
  runner: string;
  problem: string;
  /** Ordered IDs: global, project, page, layer, area, sector, card; a prefix is allowed. */
  scope: string[];
}
export const LEARNING_SIGNALS = ['availability', 'invocation', 'acceptance', 'production'] as const;
export const EVIDENCE_TIERS = ['reported', 'check', 'verified'] as const;
export type LearningSignal = typeof LEARNING_SIGNALS[number];
export type EvidenceTier = typeof EVIDENCE_TIERS[number];
/** Normalized evidence from an adapter, NOT a worker-writable verification API. */
export interface HarnessObservation {
  source: string;
  id: string;
  revision: number;
  attempt: string;
  execution: string;
  cohort: HarnessCohort;
  signal: LearningSignal;
  tier: EvidenceTier;
  outcome: 'pass' | 'fail' | 'unknown';
  durationMs: number | null;
}
export interface LearningRate {
  pass: number;
  fail: number;
  unknown: number;
  percent: number | null;
  interval95: [number, number] | null;
  coverage: number | null;
  executions: number;
  durationSamples: number;
  meanDurationMs: number | null;
}
export interface LearningSummary {
  cohort: HarnessCohort;
  signal: LearningSignal;
  tier: EvidenceTier;
  rate: LearningRate;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join('|') !== keys.sort().join('|')) throw new Error('Unexpected learning evidence fields');
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
export function parseHarnessObservation(value: unknown): HarnessObservation {
  exact(value, ['source', 'id', 'revision', 'attempt', 'execution', 'cohort', 'signal', 'tier', 'outcome', 'durationMs']);
  exact(value.cohort, ['resource', 'digest', 'runner', 'problem', 'scope']);
  const c = value.cohort;
  if (![value.source, value.id, value.attempt, value.execution, c.resource, c.runner, c.problem].every(id)
    || typeof c.digest !== 'string' || !/^[a-f0-9]{64}$/.test(c.digest)
    || !Array.isArray(c.scope) || c.scope.length < 1 || c.scope.length > 7 || !c.scope.every(id)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !LEARNING_SIGNALS.includes(value.signal as LearningSignal) || !EVIDENCE_TIERS.includes(value.tier as EvidenceTier)
    || !['pass', 'fail', 'unknown'].includes(value.outcome as string)
    || !(value.durationMs === null || (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0))) {
    throw new Error('Invalid learning evidence');
  }
  // Canonical property order makes duplicate detection independent of JSON key order.
  return { source: value.source as string, id: value.id as string, revision: value.revision as number,
    attempt: value.attempt as string, execution: value.execution as string,
    cohort: { resource: c.resource as string, digest: c.digest, runner: c.runner as string, problem: c.problem as string, scope: [...c.scope] },
    signal: value.signal as LearningSignal, tier: value.tier as EvidenceTier,
    outcome: value.outcome as HarnessObservation['outcome'], durationMs: value.durationMs as number | null };
}
export function cohortKey(c: HarnessCohort): string {
  return JSON.stringify([c.resource, c.digest, c.runner, c.problem, c.scope]);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Binomial Wilson interval in percent. This is uncertainty, not a reliability guarantee. */
export function learningRate(rows: HarnessObservation[]): LearningRate {
  const pass = rows.filter(r => r.outcome === 'pass').length;
  const fail = rows.filter(r => r.outcome === 'fail').length;
  const n = pass + fail, p = n ? pass / n : 0, z = 1.959963984540054;
  const denominator = 1 + z * z / (n || 1);
  const centre = (p + z * z / (2 * (n || 1))) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / (n || 1) + z * z / (4 * (n || 1) ** 2)) / denominator;
  const durations = rows.flatMap(r => r.durationMs === null ? [] : [r.durationMs]);
  return { pass, fail, unknown: rows.length - n, percent: n ? 100 * p : null,
    interval95: n ? [100 * Math.max(0, centre - margin), 100 * Math.min(1, centre + margin)] : null,
    coverage: rows.length ? n / rows.length : null, executions: new Set(rows.map(r => r.execution)).size,
    durationSamples: durations.length,
    meanDurationMs: durations.length ? durations.reduce((mean, d, i) => mean + (d - mean) / (i + 1), 0) : null };
}
/** Deterministic replay. Revisions replace outcomes; retries and duplicate deliveries never add votes. */
export function replayHarnessLearning(input: unknown[]): LearningSummary[] {
  const events = new Map<string, HarnessObservation>();
  const versions = new Map<string, string>();
  for (const raw of input) {
    const row = parseHarnessObservation(raw), key = JSON.stringify([row.source, row.id]);
    const version = JSON.stringify([key, row.revision]), canonical = JSON.stringify(row);
    if (versions.has(version) && versions.get(version) !== canonical) throw new Error('Conflicting evidence revision');
    versions.set(version, canonical);
    const previous = events.get(key);
    if (previous && JSON.stringify([previous.attempt, previous.execution, cohortKey(previous.cohort), previous.signal, previous.tier])
      !== JSON.stringify([row.attempt, row.execution, cohortKey(row.cohort), row.signal, row.tier])) throw new Error('Evidence identity changed');
    if (!previous || row.revision > previous.revision) events.set(key, row);
  }
  const attempts = new Set<string>(), groups = new Map<string, HarnessObservation[]>();
  for (const row of events.values()) {
    const group = JSON.stringify([cohortKey(row.cohort), row.signal, row.tier]);
    // Retrying a task cannot multiply acceptance/production votes for that execution.
    const unit = row.signal === 'acceptance' || row.signal === 'production' ? '' : row.attempt;
    const attempt = JSON.stringify([group, row.execution, unit]);
    if (attempts.has(attempt)) throw new Error('Multiple evidence identities for one attempt; reconcile in the source adapter');
    attempts.add(attempt);
    const rows = groups.get(group) ?? [];
    rows.push(row); groups.set(group, rows);
  }
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([, rows]) => ({
    cohort: rows[0].cohort, signal: rows[0].signal, tier: rows[0].tier,
    rate: learningRate(rows.sort((a, b) => compare(JSON.stringify([a.source, a.id]), JSON.stringify([b.source, b.id])))),
  }));
}
