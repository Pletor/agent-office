/** Project recommendation state, separate from manual layers and immutable accepted kits.
 * Evidence must be fetched by the server under the profile lock, never from a worker body.
 * Stable means the scoped recommendation policy passed; it does not assert causal benefit.
 */
import { createHash } from 'node:crypto';
import { HARNESS_CATEGORIES, type HarnessCategory } from '../../shared/harness.js';

export interface LifecycleScope { peer: string; project: string; workspace: string; problem: string }
export interface ToolVersion { id: string; digest: string; category: HarnessCategory; requires: string[] }
export interface LifecycleSource { verificationId: string; reportDigest: string }
export interface LifecycleEvidence {
  scope: LifecycleScope; version: ToolVersion; baseline: { id: string; digest: string };
  eligible: boolean; evidenceDigest: string; policyDigest: string;
  source?: LifecycleSource;
}
export interface LifecycleState {
  scope: LifecycleScope; active: ToolVersion; previous: ToolVersion | null;
  status: 'stable' | 'suspended'; evidenceDigest: string; policyDigest: string;
  source?: LifecycleSource; previousSource?: LifecycleSource;
  audit: { at: string; action: 'promote' | 'refresh' | 'suspend' | 'rollback'; evidenceDigest: string; triggerEvidenceDigest: string; policyDigest: string; from: ToolVersion | null; to: ToolVersion }[];
}
export interface LifecycleCheck { current: LifecycleEvidence; fallback?: LifecycleEvidence; assertCurrent?: () => void }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,199}$/.test(v);
function fail(): never { throw new Error('Invalid or incompatible Harness lifecycle evidence.'); }
const same = (a: { id: string; digest: string }, b: { id: string; digest: string }) => a.id === b.id && a.digest === b.digest;
const sameVersion = (a: ToolVersion, b: ToolVersion) => same(a, b) && a.category === b.category
  && a.requires.length === b.requires.length && a.requires.every((r, index) => r === b.requires[index]);
function version(v: unknown): asserts v is ToolVersion {
  if (!object(v) || !id(v.id) || !hash(v.digest) || !HARNESS_CATEGORIES.includes(v.category as HarnessCategory)
    || !Array.isArray(v.requires) || v.requires.length > 32 || !v.requires.every(id) || new Set(v.requires).size !== v.requires.length) fail();
}
function source(v: unknown): asserts v is LifecycleSource | undefined {
  if (v === undefined) return;
  if (!object(v) || Object.keys(v).length !== 2 || typeof v.verificationId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}(?![\s\S])/.test(v.verificationId)
    || typeof v.reportDigest !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(v.reportDigest)) fail();
}
export function lifecycleScopeKey(scope: LifecycleScope): string {
  if (!object(scope) || !id(scope.project) || !id(scope.workspace) || !id(scope.problem) || typeof scope.peer !== 'string') fail();
  const url = new URL(scope.peer);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail();
  // Require canonical origin so equivalent spellings cannot create independent histories.
  if (scope.peer !== url.origin) fail();
  return createHash('sha256').update(JSON.stringify([scope.peer, scope.project, scope.workspace, scope.problem])).digest('hex');
}
function evidence(value: LifecycleEvidence, scope: LifecycleScope) {
  if (!object(value) || lifecycleScopeKey(value.scope) !== lifecycleScopeKey(scope)) fail();
  version(value.version);
  source(value.source);
  if (!object(value.baseline) || !id(value.baseline.id) || !hash(value.baseline.digest)
    || typeof value.eligible !== 'boolean' || !hash(value.evidenceDigest) || !hash(value.policyDigest)) fail();
}
const compatible = (next: ToolVersion, before: ToolVersion) => next.category === before.category
  && next.requires.every(requirement => before.requires.includes(requirement));

export function parseLifecycle(value: unknown): LifecycleState {
  if (!object(value)) return fail();
  lifecycleScopeKey(value.scope as LifecycleScope);
  version(value.active);
  if (value.previous !== null) version(value.previous);
  source(value.source); source(value.previousSource);
  if (value.previous === null && value.previousSource !== undefined) fail();
  if (!['stable', 'suspended'].includes(value.status as string) || !hash(value.evidenceDigest) || !hash(value.policyDigest)
    || !Array.isArray(value.audit) || value.audit.length < 1 || value.audit.length > 20) fail();
  for (const row of value.audit as unknown[]) {
    if (!object(row) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))
      || !['promote', 'refresh', 'suspend', 'rollback'].includes(row.action as string) || !hash(row.evidenceDigest)
      || !hash(row.triggerEvidenceDigest) || !hash(row.policyDigest)) fail();
    version(row.to); if (row.from !== null) version(row.from);
  }
  return structuredClone(value) as unknown as LifecycleState;
}

/** Caller owns freshness, transport authority and CAS; this reducer owns version compatibility. */
export function advanceLifecycle(scope: LifecycleScope, before: LifecycleState | undefined,
  check: LifecycleCheck, operation: 'promote' | 'reconcile', at = new Date().toISOString()): LifecycleState {
  if (!['promote', 'reconcile'].includes(operation) || !Number.isFinite(Date.parse(at))) fail();
  if (before && lifecycleScopeKey(before.scope) !== lifecycleScopeKey(scope)) fail();
  const current = check.current; evidence(current, scope);
  let active = current.version, previous = before?.active ?? null;
  let previousSource = before?.source;
  let status: LifecycleState['status'] = 'stable', action: LifecycleState['audit'][number]['action'] = 'promote';
  if (operation === 'promote') {
    if (!current.eligible || (before && (before.status !== 'stable' || !same(current.baseline, before.active)
      || !compatible(current.version, before.active)))) fail();
    if (before && sameVersion(current.version, before.active)) {
      previous = before.previous; previousSource = before.previousSource; action = 'refresh';
    }
  } else {
    if (!before || !sameVersion(current.version, before.active)) fail();
    active = before.active; previous = before.previous; action = current.eligible ? 'refresh' : 'suspend';
    previousSource = before.previousSource;
    status = current.eligible ? 'stable' : 'suspended';
    if (!current.eligible && check.fallback) {
      evidence(check.fallback, scope);
      if (!previous || !sameVersion(check.fallback.version, previous) || !compatible(previous, active)) fail();
      if (check.fallback.eligible) {
        active = previous; previous = null; previousSource = undefined; status = 'stable'; action = 'rollback';
      }
    }
  }
  const selected = action === 'rollback' ? check.fallback! : current;
  // Keep the source of a suspended version so it can be reassessed later. It is a
  // lookup reference only: eligibility still requires a new native assessment.
  const selectedSource = selected.source ?? (action === 'suspend' ? before?.source : undefined);
  const state: LifecycleState = { scope: structuredClone(scope), active: structuredClone(active), previous: structuredClone(previous),
    status, evidenceDigest: selected.evidenceDigest, policyDigest: selected.policyDigest,
    ...(selectedSource ? { source: structuredClone(selectedSource) } : {}),
    ...(previousSource ? { previousSource: structuredClone(previousSource) } : {}),
    audit: [...(before?.audit ?? []).slice(-19), { at, action, evidenceDigest: selected.evidenceDigest,
      triggerEvidenceDigest: current.evidenceDigest, policyDigest: selected.policyDigest,
      from: before?.active ? structuredClone(before.active) : null, to: structuredClone(active) }] };
  return parseLifecycle(state);
}
