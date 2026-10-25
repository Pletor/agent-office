import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPinnedNode } from './invoke-node-process.js';
import { invocationObservation } from './invoke-observation.js';
import { validateAdapterKit } from './adapter-kit.js';

type Execution = { executionId: string; epoch: number; project: string; workspace: string; nodeId: string; acceptedRevision: string; assignmentDigest: string };
type Resource = { resource: string; category: string; content: string; digest: string; requires: string[] };
type Receipt = { execution: Execution; kit: { schema: string; resources: Resource[]; [key: string]: unknown } | null };
export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/;
const invalid = () => new Error('Current accepted kit is unavailable or invalid.');

/** The endpoint owns authentication and accepted assignment lookup. Never read caller-supplied kit files. */
export async function acceptedReceipt(base: string, worker: string, token: string, options: { allowEmptyKit?: boolean } = {}): Promise<Receipt> {
  if (!base || !worker || !token) throw new Error('Use the current worker hook credentials.');
  const url = new URL('/office/harness', base);
  url.searchParams.set('worker', worker); url.searchParams.set('accepted-kit', '1');
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw invalid(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024) throw invalid();
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Receipt;
  const e = value?.execution;
  if (!e || !['executionId', 'project', 'workspace', 'nodeId'].every(k => typeof e[k as keyof Execution] === 'string' && ID.test(e[k as keyof Execution] as string))
    || !Number.isSafeInteger(e.epoch) || e.epoch < 1 || typeof e.acceptedRevision !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/.test(e.acceptedRevision)
    || typeof e.assignmentDigest !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(e.assignmentDigest)) throw invalid();
  if (!(options.allowEmptyKit && value.kit === null)) {
    if (!value.kit || !Array.isArray(value.kit.resources) || value.kit.resources.length > 24) throw invalid();
    await validateAdapterKit(value.kit);
  }
  return { execution: { executionId: e.executionId, epoch: e.epoch, project: e.project, workspace: e.workspace,
    nodeId: e.nodeId, acceptedRevision: e.acceptedRevision, assignmentDigest: e.assignmentDigest }, kit: value.kit };
}

const identity = (r: Receipt) => JSON.stringify([r.execution.executionId, r.execution.epoch, r.execution.project,
  r.execution.workspace, r.execution.nodeId, r.execution.acceptedRevision, r.execution.assignmentDigest]);

/** Explicit local execution, with the worker's OS identity; observations are not independent verification. */
export async function invokeNode(read: () => Promise<Receipt>, resourceId: string, args: string[], cwd: string,
  options: { timeoutMs?: number; pollMs?: number; tempRoot?: string } = {}) {
  if (!ID.test(resourceId) || args.length > 32 || args.some(a => typeof a !== 'string' || a.includes('\0'))
    || Buffer.byteLength(JSON.stringify(args)) > 16 * 1024)
    throw new Error('Choose one resource and at most 32 arguments / 16 KiB of arguments. Put larger input in a file inside the working directory and pass its path; the script may read that directory.');
  if (!process.allowedNodeEnvironmentFlags.has('--permission')) throw new Error('This Node runtime lacks the required permission controls.');
  if (/[,\*]/.test(path.resolve(cwd)) || /[,\*]/.test(options.tempRoot ?? tmpdir()))
    throw new Error('Working and temporary paths cannot contain permission-pattern characters.');
  const receipt = await read();
  await validateAdapterKit(receipt.kit);
  const originalIdentity = identity(receipt);
  const matches = receipt.kit?.resources.filter(r => r.resource === resourceId) ?? [];
  const resource = matches[0];
  if (matches.length !== 1 || resource.category !== 'scripts' || typeof resource.content !== 'string'
    || Buffer.byteLength(resource.content) > 96 * 1024 || resource.content.includes('\0')
    || [...resource.content].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })
    || sha256(resource.content) !== resource.digest) throw invalid();
  if (!Array.isArray(resource.requires) || resource.requires.length !== 1 || resource.requires[0] !== 'command:node')
    throw new Error('Node scripts must declare exactly command:node; other requirements need another adapter.');
  const directory = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), 'office-harness-invoke-'));
  let cleanup = true;
  try {
    const file = path.join(directory, 'accepted.mjs');
    await writeFile(file, resource.content, { flag: 'wx', mode: 0o600 });
    if (sha256(await readFile(file)) !== resource.digest) throw invalid();
    const check = async () => identity(await read()) === originalIdentity;
    if (!await check()) throw new Error('Execution changed before tool launch.');
    const result = await runPinnedNode(file, args, path.resolve(cwd), directory, check, options);
    // Recheck after exit: successful work after authority loss must not become a successful receipt.
    let current = false;
    try { current = await check(); } catch { /* unavailable is not current */ }
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); } catch { cleanup = false; }
    const measured = { schema: 'harness.invocation/1', invocationId: randomUUID(), execution: receipt.execution,
      resource: { id: resource.resource, digest: resource.digest }, adapter: 'node-readonly/1', nodeVersion: process.version,
      ...result, outcome: current && cleanup && result.reason === 'completed' && result.exitCode === 0 ? 'pass' : 'fail',
      authorityCurrentAtCompletion: current, cleanupComplete: cleanup, evidence: 'worker-observed', independentlyVerified: false,
      causalContribution: false, promotionAllowed: false, tokens: null, cost: null };
    return { ...measured, observation: invocationObservation(measured) };
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => { cleanup = false; }); }
}
