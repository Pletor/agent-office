import { createHash } from 'node:crypto';

export interface PairExecution {
  executionId: string; epoch: number; project: string; workspace: string; nodeId: string;
  acceptedRevision: string; assignmentDigest: string;
}
export interface PairResource { resource: string; category: string; content: string; digest: string; requires: string[] }
export interface PairReceipt { execution: PairExecution; kit: { schema: string; problems: string[]; resources: PairResource[]; [key: string]: unknown } | null }
export interface PairCase { id: string; args: string[]; expectedStdout: string }
export interface PairPlan { schema: 'harness.paired-node/1'; problem: string; baseline: string; candidate: string; cases: PairCase[] }
export interface PreparedPair {
  selectionDigest?: string;
  execution: PairExecution; plan: PairPlan; resource: { id: string; digest: string };
  baseline: { id: string; digest: string }; candidate: { id: string; digest: string };
}
const fail = (): never => { throw new Error('Invalid accepted paired plan.'); };
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const utf8 = (s: unknown, max: number): s is string => typeof s === 'string' && !s.includes('\0')
  && ![...s].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; }) && Buffer.byteLength(s) <= max;
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export async function preparePair(input: PairReceipt, planResourceId: string): Promise<PreparedPair> {
  const receipt = structuredClone(input);
  const e = receipt?.execution, kit = receipt?.kit;
  if (kit?.schema === 'harness.kit/2') {
    const modulePath = './adapter-kit.js';
    const adapter = await import(modulePath).catch(() => { throw new Error('Paired v2 validation is unavailable in this installation.'); });
    if (typeof adapter.validateAdapterKit !== 'function') throw new Error('Paired v2 validation is unavailable in this installation.');
    await adapter.validateAdapterKit(kit);
  }
  if (!obj(e) || !exact(e, ['executionId', 'epoch', 'project', 'workspace', 'nodeId', 'acceptedRevision', 'assignmentDigest'])
    || ![e.executionId, e.project, e.workspace, e.nodeId].every(id) || !Number.isSafeInteger(e.epoch) || e.epoch < 1
    || typeof e.acceptedRevision !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/.test(e.acceptedRevision) || !hash(e.assignmentDigest)
    || !id(planResourceId) || !kit || !['harness.kit/1', 'harness.kit/2'].includes(kit.schema) || !Array.isArray(kit.problems)
    || kit.problems.length !== 1 || kit.problems[0] !== 'evaluation:paired-node'
    || !Array.isArray(kit.resources) || kit.resources.length > 24) return fail();
  const planMatches = kit.resources.filter(r => obj(r) && r.resource === planResourceId);
  if (planMatches.length !== 1) return fail();
  const pr = planMatches[0];
  if (!id(pr.resource) || pr.category !== 'testing' || !Array.isArray(pr.requires) || pr.requires.length !== 0
    || !utf8(pr.content, 32 * 1024) || !hash(pr.digest) || digest(pr.content) !== pr.digest) return fail();
  let raw: unknown;
  try { raw = JSON.parse(pr.content); } catch { return fail(); }
  if (!obj(raw) || !exact(raw, ['schema', 'problem', 'baseline', 'candidate', 'cases']) || raw.schema !== 'harness.paired-node/1'
    || !id(raw.problem) || !id(raw.baseline) || !id(raw.candidate) || raw.baseline === raw.candidate || raw.baseline === planResourceId || raw.candidate === planResourceId
    || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 8) return fail();
  const caseIds = new Set<string>();
  const cases = raw.cases.map((c: unknown): PairCase => {
    if (!obj(c) || !exact(c, ['id', 'args', 'expectedStdout']) || !id(c.id) || caseIds.has(c.id) || !Array.isArray(c.args) || c.args.length > 32
      || c.args.some((a: unknown) => !utf8(a, 16 * 1024)) || Buffer.byteLength(JSON.stringify(c.args)) > 16 * 1024 || !utf8(c.expectedStdout, 8 * 1024)) return fail();
    caseIds.add(c.id);
    return { id: c.id, args: [...c.args], expectedStdout: c.expectedStdout };
  });
  const resource = (rid: string) => {
    const matches = kit.resources.filter(r => obj(r) && r.resource === rid);
    if (matches.length !== 1) return fail();
    const r = matches[0];
    if (!id(r.resource) || r.category !== 'scripts' || !Array.isArray(r.requires) || r.requires.length !== 1
      || r.requires[0] !== 'command:node' || !utf8(r.content, 96 * 1024) || !hash(r.digest) || digest(r.content) !== r.digest) return fail();
    return { id: r.resource, digest: r.digest };
  };
  const baseline = resource(raw.baseline), candidate = resource(raw.candidate);
  return { execution: { executionId: e.executionId, epoch: e.epoch, project: e.project, workspace: e.workspace,
    nodeId: e.nodeId, acceptedRevision: e.acceptedRevision, assignmentDigest: e.assignmentDigest },
    plan: { schema: 'harness.paired-node/1', problem: raw.problem, baseline: raw.baseline, candidate: raw.candidate, cases },
    resource: { id: pr.resource, digest: pr.digest }, baseline, candidate,
    ...(kit.schema === 'harness.kit/2' ? { selectionDigest: digest(JSON.stringify(kit.selection)) } : {}) };
}
