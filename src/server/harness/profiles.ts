import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveHarness, type HarnessLayer, type HarnessProfile, type HarnessScope } from '../../shared/harness-cascade.js';

export class HarnessError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function parseHarnessLayer(value: unknown): HarnessLayer {
  if (!object(value) || Object.keys(value).length > 64) throw new HarnessError('A layer must be an object with at most 64 slots.');
  for (const [key, binding] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new HarnessError('Invalid slot name: ' + key);
    if (binding === null) continue;
    if (!object(binding) || Object.keys(binding).length !== 1) throw new HarnessError('Each slot needs exactly {resource: id}, {value: scalar}, or null.');
    if (typeof binding.resource === 'string' && binding.resource.length > 0 && binding.resource.length <= 100) continue;
    const v = binding.value;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 4000)) continue;
    throw new HarnessError('Invalid binding for ' + key);
  }
  return structuredClone(value) as HarnessLayer;
}
interface Stored { revision: number; layers: Record<string, HarnessLayer> }
/** Synchronous bounded transactions serialize writes within the office process; atomic replacement survives restarts. */
export class HarnessProfiles {
  private file: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'harness-profiles.json'); }
  private read(): Stored {
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, layers: {} }; throw err; }
    try {
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.layers)) throw new Error('invalid schema');
      for (const layer of Object.values(data.layers)) parseHarnessLayer(layer);
      return data;
    } catch { throw new HarnessError('Harness profiles are unreadable. Repair the saved file; it has not been overwritten.', 503); }
  }
  private keys(repo: string, task = '') {
    if (task.length > 500 || /[\x00-\x1f]/.test(task)) throw new HarnessError('Invalid task ID');
    const dir = path.resolve(repo);
    const key = createHash('sha256').update(process.platform === 'win32' ? dir.toLowerCase() : dir).digest('hex');
    return { global: 'global', repository: 'repo:' + key, task: 'task:' + key + ':' + task };
  }
  view(repo: string, task = ''): HarnessProfile {
    const data = this.read(), keys = this.keys(repo, task);
    const layers = { global: data.layers.global ?? {}, repository: data.layers[keys.repository] ?? {}, task: task ? data.layers[keys.task] ?? {} : {} };
    return { revision: data.revision, layers, effective: resolveHarness(layers) };
  }
  save(repo: string, task: string, scope: HarnessScope, layer: unknown, revision: unknown): HarnessProfile {
    if (!['global', 'repository', 'task'].includes(scope) || (scope === 'task' && !task.trim())) throw new HarnessError('Choose a scope and a task ID for task overrides.');
    const next = parseHarnessLayer(layer), data = this.read();
    if (revision !== data.revision) throw new HarnessError('Profiles changed elsewhere. Reload before saving.', 409);
    const key = this.keys(repo, task)[scope];
    if (Object.keys(next).length) data.layers[key] = next; else delete data.layers[key];
    data.revision++;
    const text = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new HarnessError('Harness profile storage is full.');
    mkdirSync(this.dataDir, { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, this.file);
    return this.view(repo, task);
  }
}
