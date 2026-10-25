/** Worker-local readiness of an immutable kit; never executes resource contents. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HARNESS_CATEGORIES } from '../../shared/harness.js';
import { acceptedReceipt, sha256 } from './invoke-node.js';
import { runPinnedNode } from './invoke-node-process.js';
import { validateAdapterKit } from './adapter-kit.js';
import type { DocumentationProbe } from './prepare-documentation.js';

type Reader = () => ReturnType<typeof acceptedReceipt>;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/;
const CONTEXT = new Set(['instructions', 'skills', 'rules', 'memory', 'testing', 'operations']);
const CATEGORIES = new Set<string>([...HARNESS_CATEGORIES, 'plugins', 'permissions']);
const PROBE = "console.log('harness-node-readiness/1')";

export async function prepareAccepted(read: Reader, cwd: string, options: { tempRoot?: string; documentation?: DocumentationProbe } = {}) {
  const receipt = structuredClone(await read());
  await validateAdapterKit(receipt.kit);
  if (!receipt.kit || !Array.isArray(receipt.kit.resources) || receipt.kit.resources.length > 24)
    throw new Error('Accepted kit is unavailable.');
  const identity = JSON.stringify(receipt.execution), seen = new Set<string>();
  let total = 0;
  const resources = receipt.kit.resources.map(resource => {
    if (typeof resource.resource !== 'string' || !ID.test(resource.resource) || seen.has(resource.resource) || !CATEGORIES.has(resource.category)
      || typeof resource.content !== 'string' || resource.content.includes('\0')
      || [...resource.content].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })
      || sha256(resource.content) !== resource.digest || !Array.isArray(resource.requires)
      || resource.requires.length > 32 || !resource.requires.every(r => typeof r === 'string' && ID.test(r))
      || new Set(resource.requires).size !== resource.requires.length)
      throw new Error('Invalid accepted resource.');
    total += Buffer.byteLength(resource.content);
    if (total > 96 * 1024) throw new Error('Accepted kit exceeds preparation limits.');
    seen.add(resource.resource);
    const node = resource.category === 'scripts' && resource.requires.length === 1 && resource.requires[0] === 'command:node';
    const context = CONTEXT.has(resource.category) && resource.requires.length === 0;
    const docs = resource.category === 'mcp' && resource.requires.length === 1 && resource.requires[0] === 'mcp:context7';
    return { id: resource.resource, digest: resource.digest, category: resource.category, requires: [...resource.requires],
      mode: node ? 'node-readonly' : context ? 'context' : docs ? 'context7-documentation' : 'unsupported',
      state: context ? 'prepared' : node || docs ? 'unavailable' : 'unsupported',
      reason: context ? 'pinned-context-readable' : node || docs ? 'probe-not-run' : 'adapter-or-requirement-unsupported' };
  });
  const current = async () => JSON.stringify((await read()).execution) === identity;
  let cleanupComplete = true, probe: { outcome: string; reason: string; durationMs: number | null } | null = null;
  if (resources.some(r => r.mode === 'node-readonly')) {
    if (!process.allowedNodeEnvironmentFlags.has('--permission')) probe = { outcome: 'unavailable', reason: 'node-permission-mode-unavailable', durationMs: null };
    else if (/[,\*]/.test(path.resolve(cwd)) || /[,\*]/.test(options.tempRoot ?? tmpdir()))
      probe = { outcome: 'unavailable', reason: 'permission-path-unsupported', durationMs: null };
    else {
      const scratch = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), 'office-harness-prepare-'));
      try {
        const file = path.join(scratch, 'probe.mjs');
        await writeFile(file, PROBE, { flag: 'wx', mode: 0o600 });
        if (!await current()) throw new Error('Execution changed before preparation.');
        const result = await runPinnedNode(file, [], path.resolve(cwd), scratch, current, { timeoutMs: 5000 });
        const ok = result.reason === 'completed' && result.exitCode === 0 && result.stdout === 'harness-node-readiness/1\n';
        probe = { outcome: ok ? 'pass' : 'unavailable', reason: ok ? 'fixed-node-probe-passed' : 'fixed-node-probe-failed', durationMs: result.durationMs };
      } finally {
        try { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { cleanupComplete = false; }
      }
    }
  }
  let documentationCalls = 0;
  for (const resource of resources.filter(r => r.mode === 'context7-documentation')) {
    if (!options.documentation) { resource.reason = 'documentation-adapter-unavailable'; continue; }
    if (documentationCalls >= 2) { resource.reason = 'documentation-probe-budget'; continue; }
    try {
      if (!await current()) { resource.reason = 'execution-changed-or-unavailable'; continue; }
      documentationCalls++;
      const passed = await options.documentation(receipt.execution, { id: resource.id, digest: resource.digest });
      resource.state = passed ? 'prepared' : 'unavailable';
      resource.reason = passed ? 'accepted-documentation-probe-passed' : 'accepted-documentation-probe-failed';
    } catch { resource.state = 'unavailable'; resource.reason = 'accepted-documentation-probe-failed'; }
  }
  let authorityCurrentAtCompletion = false;
  try { authorityCurrentAtCompletion = await current(); } catch { /* Unavailable authority is not ready. */ }
  for (const resource of resources) {
    if (!authorityCurrentAtCompletion || !cleanupComplete) {
      resource.state = 'unavailable'; resource.reason = !cleanupComplete ? 'cleanup-incomplete' : 'execution-changed-or-unavailable';
    } else if (resource.mode === 'node-readonly') {
      resource.state = probe?.outcome === 'pass' ? 'prepared' : 'unavailable'; resource.reason = probe?.reason ?? 'probe-not-run';
    }
  }
  return { schema: 'harness.preparation/1', scope: 'worker-process', execution: receipt.execution,
    resources, probe, documentationCalls, ready: authorityCurrentAtCompletion && cleanupComplete && resources.every(r => r.state === 'prepared'),
    authorityCurrentAtCompletion, cleanupComplete, nodeVersion: process.version,
    evidence: 'worker-observed', resourceContentsExecuted: false, permissionsGranted: false,
    independentlyVerified: false, causalContribution: false, promotionAllowed: false };
}
