import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessLibrary } from '../src/server/harness/catalog.js';
import { recommendHarness } from '../src/server/harness/recommend.js';
import { recommendationSelection } from '../src/server/harness/recommendation-selection.js';
import { requireKitV2 } from '../src/server/harness/kit-compatibility.js';
import * as cascade from '../src/shared/harness-cascade.js';

const declaration = () => ({ schema: 'harness.kit-capabilities/1', scope: { project: 'p', workspace: 'w' },
  acceptedKitSchemas: ['harness.kit/1', 'harness.kit/2'], contextProtocolVersion: 2, selectionSchema: 'harness.selection/1',
  limits: { resources: 24, bytes: 96 * 1024 }, evidence: 'installed-acceptance-validator',
  executionAdaptersVerified: false, permissionsGranted: false, promotionAllowed: false });
test('compatibility reads only fixed scoped peer with bounds and refuses incompatible claims', async () => {
  let calls = 0;
  const transport = (async (url: URL, options: RequestInit) => {
    calls++; assert.equal(url.pathname, '/api/oporahub/harness-kit-capabilities');
    assert.equal(url.searchParams.get('project'), 'p'); assert.equal(url.searchParams.get('workspace'), 'w');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers, undefined);
    assert.ok(options.signal); return Response.json(declaration());
  }) as typeof fetch;
  await requireKitV2('http://peer/ignored', 'p', 'w', transport);
  await assert.rejects(requireKitV2('http://user:secret@peer', 'p', 'w', transport)); assert.equal(calls, 1);
  for (const change of [(v: any) => v.scope.project = 'other', (v: any) => v.acceptedKitSchemas = ['harness.kit/1'],
    (v: any) => v.permissionsGranted = true, (v: any) => v.limits.bytes = 100]) {
    const value = declaration(); change(value);
    await assert.rejects(requireKitV2('http://peer', 'p', 'w', (async () => Response.json(value)) as typeof fetch));
  }
  await assert.rejects(requireKitV2('http://peer', 'p', 'w', (async () => new Response('x'.repeat(8193))) as typeof fetch));
  await assert.rejects(requireKitV2('http://peer', 'p', 'w', (async () => new Response('', { status: 404 })) as typeof fetch));
});

test('writer pins seven effective origins and settings, refuses missing origins, preserves v1 input', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-selection-writer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'rules')); writeFileSync(path.join(dir, 'rules', 'quality.md'), 'Check results.');
  const library = new HarnessLibrary([{ name: 'Project / .harness', dir }]);
  const id = (await library.list()).entries.find(e => e.path === 'rules/quality.md')!.id;
  const scopes = ['global', 'repository', 'page', 'layer', 'area', 'sector', 'task'];
  let effective: any = Object.fromEntries(scopes.map(scope => [scope, { binding: { resource: id }, scope,
    ...(['global', 'repository'].includes(scope) ? {} : { node: 'opora:p:w:' + scope }) }]));
  effective['settings.harness.auto'] = { binding: { value: false }, scope: 'global' };
  const layers: any = Object.fromEntries(scopes.map(scope => [scope, { [scope]: { resource: id } }]));
  layers.global['settings.harness.auto'] = { value: false };
  const ancestry = scopes.slice(2).map(level => ({ level, node: 'opora:p:w:' + level }));
  if ((cascade as any).HARNESS_LEVELS?.length === 7) effective = (cascade.resolveHarness as any)(layers, ancestry);
  const profile: any = { revision: 7, layers, path: ancestry, effective };
  const result = await recommendHarness(library, 'build', [], profile), before = structuredClone(result);
  const missing = structuredClone(profile); delete missing.effective.task.node;
  await assert.rejects(recommendationSelection(result, missing, []), /hierarchy resolver/);
  if (!existsSync(new URL('../src/server/harness/accepted-kit.ts', import.meta.url))) {
    await assert.rejects(recommendationSelection(result, profile, []), /validator is unavailable/);
  } else {
    const output = await recommendationSelection(result, profile, []);
    const kit = output.kit as any;
    assert.equal(kit.schema, 'harness.kit/2'); assert.equal(kit.selection.entries.length, kit.resources.length);
    const origins = kit.selection.entries[0].assignments;
    assert.equal(origins.length, 7);
    for (const origin of origins) assert.equal(origin.node, ['global', 'repository'].includes(origin.scope) ? null : 'opora:p:w:' + origin.scope);
    assert.equal(kit.selection.entries.at(-1).reason, 'inherited-settings');
    assert.equal(kit.selection.evidence, 'caller-declared-selection');
    const changed = structuredClone(result); changed.selection[0].versionDigest = '0'.repeat(64);
    await assert.rejects(recommendationSelection(changed, profile, []), /selection changed/);
  }
  assert.deepEqual(result, before); assert.equal(result.kit!.schema, 'harness.kit/1');
});
