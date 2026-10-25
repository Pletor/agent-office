import { harnessLevel, type HarnessLevel } from './harness-cascade.js';
import { HARNESS_CATEGORIES } from './harness.js';

export interface OriginRate { pass: number; fail: number; unknown: number; executions: number; interval95: [number, number] | null }
export interface OriginCohort {
  resource: string; digest: string; versionDigest: string; category: string; problem: string;
  tier: 'reported' | 'verified'; origin: { scope: HarnessLevel | 'unknown'; node: string | null };
  tasks: number; rate: OriginRate;
}
export interface OriginHistory {
  schema: 'harness.origin-history/1'; scope: { project: string; workspace: string; nodeId: null };
  originEvidence: 'caller-declared-selection-origin; not verified ancestry';
  association: 'selected-kit; origins overlap; do not sum across origins';
  window: { kind: 'newest-enrolled-executions'; limit: number; examined: number; excluded: number };
  limited: boolean; omittedCohortContributions: number; cohorts: OriginCohort[];
  promotionAllowed: false; causalContribution: false; invocationObserved: false;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,199}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const invalid = (): never => { throw new Error('Neplatná odpověď historie původu.'); };

/** Project a whitelist only. Native outcome tier never authenticates caller-declared ancestry. */
export function parseOriginHistory(value: unknown, project: string, workspace: string): OriginHistory {
  if (!object(value) || value.schema !== 'harness.origin-history/1' || !object(value.scope)
    || value.scope.project !== project || value.scope.workspace !== workspace || value.scope.nodeId !== null
    || value.promotionAllowed !== false || value.causalContribution !== false || value.invocationObserved !== false
    || !object(value.window) || value.window.kind !== 'newest-enrolled-executions'
    || !count(value.window.limit) || value.window.limit < 1 || value.window.limit > 100
    || !count(value.window.examined) || value.window.examined > value.window.limit
    || !count(value.window.excluded) || value.window.excluded > value.window.examined
    || typeof value.limited !== 'boolean' || !count(value.omittedCohortContributions)
    || value.omittedCohortContributions > 0 && !value.limited
    || !Array.isArray(value.cohorts) || value.cohorts.length > 100) return invalid();
  const seen = new Set<string>();
  const cohorts: OriginCohort[] = value.cohorts.map((c: unknown) => {
    if (!object(c) || !id(c.resource) || !hash(c.digest) || !hash(c.versionDigest) || !id(c.problem)
      || !HARNESS_CATEGORIES.some(category => category === c.category)
      || !['reported', 'verified'].includes(c.tier) || !object(c.origin)
      || c.origin.scope !== 'unknown' && !harnessLevel(c.origin.scope)
      || c.origin.node !== null && (typeof c.origin.node !== 'string' || c.origin.node.length > 1024 || /[\x00-\x1f]/.test(c.origin.node))
      || ['global', 'repository', 'unknown'].includes(c.origin.scope) && c.origin.node !== null
      || !count(c.tasks) || !object(c.rate)) return invalid();
    const r = c.rate;
    if (![r.pass, r.fail, r.unknown, r.executions].every(count) || r.executions !== r.pass + r.fail + r.unknown
      || r.executions > value.window.examined - value.window.excluded || c.tasks > r.executions
      || (r.interval95 !== null && (!Array.isArray(r.interval95) || r.interval95.length !== 2
        || !r.interval95.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)
        || r.interval95[0] > r.interval95[1]))) return invalid();
    const key = JSON.stringify([c.resource, c.versionDigest, c.problem, c.tier, c.origin.scope, c.origin.node]);
    if (seen.has(key)) return invalid(); seen.add(key);
    return { resource: c.resource, digest: c.digest, versionDigest: c.versionDigest, category: c.category,
      problem: c.problem, tier: c.tier, origin: { scope: c.origin.scope, node: c.origin.node }, tasks: c.tasks,
      rate: { pass: r.pass, fail: r.fail, unknown: r.unknown, executions: r.executions, interval95: r.interval95 } };
  });
  return { schema: 'harness.origin-history/1', scope: { project, workspace, nodeId: null },
    originEvidence: 'caller-declared-selection-origin; not verified ancestry',
    association: 'selected-kit; origins overlap; do not sum across origins',
    window: { kind: 'newest-enrolled-executions', limit: value.window.limit, examined: value.window.examined, excluded: value.window.excluded },
    limited: value.limited, omittedCohortContributions: value.omittedCohortContributions, cohorts,
    promotionAllowed: false, causalContribution: false, invocationObserved: false };
}
