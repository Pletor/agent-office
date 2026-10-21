// The preparation runner's test setup (tests/harness-prepare*.test.ts): Shop's checkout with a rule bound
// at the project, a fake Opora, the fake adapter registered, and a bridge on a fake floor wired to the
// runner and its recovery, plus the readers the tests assert with.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HarnessProfiles } from '../../src/server/harness/profiles.js';
import { HarnessLibrary, harnessSources } from '../../src/server/harness/catalog.js';
import { HarnessRegistry } from '../../src/server/harness/registry.js';
import { fakeAdapter, registerAdapter, type FakeAdapterOptions } from '../../src/server/harness/adapters.js';
import { type PrepareOptions } from '../../src/server/harness/prepare.js';
import { preparedCardRun, recoverRuns } from '../../src/server/harness/prepare-recover.js';
import { listRecords } from '../../src/server/harness/prepare-store.js';
import { bridgeOn, fakeFloor, fakeOpora } from './prepare-opora.js';

export const place = { project: 'p1', workspace: 'draft' };

/** Shop's checkout with a rule bound at the project, the fake adapter registered and named by the profile when `adapters` says so. */
export async function setup(t: { after(fn: () => void | Promise<void>): void }, o: { adapters?: string; fake?: FakeAdapterOptions; options?: PrepareOptions; seat?: (deskId: string, prompt: string) => string | undefined; workersFile?: boolean; files?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-prepare-'));
  const op = await fakeOpora(dir);
  const cleanup: (() => void | Promise<void>)[] = [() => op.close(), () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 })];
  t.after(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
  mkdirSync(path.join(dir, '.harness', 'rules'), { recursive: true });
  writeFileSync(path.join(dir, '.harness', 'rules', 'review.md'), 'Review every change.\n');
  for (let i = 0; i < (o.files ?? 0); i++) writeFileSync(path.join(dir, '.harness', 'rules', `extra-${i}.md`), `Rule ${i}.\n`);
  const catalog = await new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).list();
  const rule = catalog.entries.find((e) => e.path === 'rules/review.md')!.id;
  const profiles = new HarnessProfiles(dir);
  await profiles.save(dir, '', 'global', { language: { value: 'en' } }, 0);
  await profiles.save(dir, '', 'repository', { 'rules.review': { resource: rule }, ...(o.adapters !== undefined ? { adapters: { value: o.adapters } } : {}) }, 1);
  const fake = fakeAdapter(o.fake);
  const off = registerAdapter(fake.adapter);
  const { floor, workers } = fakeFloor(dir, o.workersFile ? path.join(dir, 'workers.json') : undefined, o.seat);
  const { bridge, toasts } = bridgeOn(floor, dir, op.url, {
    prepareTask: (project, workspace, card, _owner, nodes) => preparedCardRun(dir, dir, { project, workspace }, card, nodes, false, o.options, 'shop'),
    recoverRuns: async (recovery) => (await recoverRuns(dir, dir, recovery)).adopted,
  });
  cleanup.push(off, () => bridge.shutdown());
  await bridge.poll();
  return { dir, op, bridge, toasts, workers, fake, profiles, rule };
}

/** A bridge of an office started again on `dir` (a fresh fake floor reading the workers a stopped one left). */
export function restarted(t: { after(fn: () => void | Promise<void>): void }, dir: string, url: string) {
  const { floor, workers } = fakeFloor(dir, path.join(dir, 'workers.json'));
  const again = bridgeOn(floor, dir, url, { prepareTask: (project, workspace, card, _o, nodes) => preparedCardRun(dir, dir, { project, workspace }, card, nodes, false, {}, 'shop'), recoverRuns: async (r) => (await recoverRuns(dir, dir, r)).adopted });
  t.after(() => again.bridge.shutdown());
  return { ...again, workers };
}

export const records = (dir: string) => listRecords(dir).records;
export const snapshots = (dir: string) => (existsSync(path.join(dir, 'harness-snapshots')) ? readdirSync(path.join(dir, 'harness-snapshots')) : []);
export const leaseOps = (op: { calls: { path: string; body?: Record<string, unknown> }[] }, kind: string) => op.calls.filter((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === kind);

/** Every file under `dir` with a digest of its content and its modification time: what a dry run must leave exactly as it was. */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const file = path.join(at, name), stat = statSync(file);
      if (stat.isDirectory()) { out[path.relative(dir, file) + '/'] = 'dir'; walk(file); }
      else out[path.relative(dir, file)] = createHash('sha256').update(readFileSync(file)).digest('hex') + '@' + stat.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

/** An office process that stops in the middle of a take (tests/fixtures/prepare-crash.ts names the points). */
export const crash = (mode: string, dir: string, url: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'prepare-crash.ts'), mode, dir, url, path.join(dir, 'workers.json')], { cwd: path.join(import.meta.dirname, '..', '..'), timeout: 110_000 });
