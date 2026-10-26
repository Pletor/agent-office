// Defined things in the library (docs/harness-items.md): parsing, parts carried into a kit, and a kit proposed into one Opora card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.ts';
import { parseItem, itemView } from '../src/server/harness/items.ts';
import { buildHarnessKit } from '../src/server/harness/kit.ts';
import { proposeKit } from '../src/server/harness/propose.ts';
import { oporaKey } from '../src/shared/opora-identity.ts';
import type { Floor } from '../src/server/floor.ts';

const library = new HarnessLibrary(harnessSources(process.cwd(), false));
const byPath = async (file: string) => (await library.list()).entries.find(entry => entry.source === 'Project / .harness' && entry.path === file)!;
const hook = { schema: 'harness.item/1', kind: 'hook', name: 'x', summary: 'S', deterministic: true,
  trigger: { event: 'PostToolUse', matcher: 'Edit' }, run: { runner: 'node', entry: 'scripts/x.mjs' }, parts: [{ path: 'scripts/x.mjs', role: 'script' }] };

test('the repository\'s own definitions parse, and each part is in the library', async () => {
  for (const file of ['scripts/ts-refs.item.json', 'hooks/typecheck-on-edit.item.json', 'skills/ts-references/ts-references.item.json']) {
    const entry = await byPath(file);
    assert.ok(entry, file + ' is listed');
    const view = itemView({ ...entry, text: readFileSync('.harness/' + file, 'utf8') }, (await library.list()).entries);
    assert.ok(!('error' in view), file + ': ' + ('error' in view ? view.error : ''));
    assert.ok(view.parts.length >= 1);
  }
});

test('a definition is exact: unknown fields, a hook without a trigger, a run outside the parts and the wrong folder are refused', () => {
  assert.equal(parseItem(JSON.stringify(hook), 'hooks').run?.args.length, 0);
  assert.throws(() => parseItem(JSON.stringify({ ...hook, verified: true }), 'hooks'), /Neznámá pole/);
  assert.throws(() => parseItem(JSON.stringify({ ...hook, trigger: undefined }), 'hooks'), /trigger/);
  assert.throws(() => parseItem(JSON.stringify({ ...hook, parts: [] }), 'hooks'), /run.entry/);
  assert.throws(() => parseItem(JSON.stringify(hook), 'skills'), /patří do složky hooks/);
  assert.throws(() => parseItem(JSON.stringify({ ...hook, parts: [{ path: '../x.mjs', role: 'script' }] }), 'hooks'), /Část/);
  assert.throws(() => parseItem(JSON.stringify({ ...hook, run: { runner: 'bash', entry: 'scripts/x.mjs' } }), 'hooks'), /run/);
});

test('a skill in a kit brings its instructions, reference and script; the script may be invoked with node', async () => {
  const skill = await byPath('skills/ts-references/ts-references.item.json');
  const kit = await buildHarnessKit(library, 'bugfix', [skill.id]);
  const paths = await Promise.all(kit.resources.map(async resource => (await library.list()).entries.find(entry => entry.id === resource.resource)!.path));
  assert.deepEqual(paths, ['skills/ts-references/ts-references.item.json', 'skills/ts-references/SKILL.md', 'skills/ts-references/references/lsp-vs-grep.md', 'scripts/ts-refs.mjs']);
  assert.deepEqual(kit.resources.map(resource => resource.requires), [[], [], [], ['command:node']]);
  // A part chosen explicitly too is carried once.
  const script = await byPath('scripts/ts-refs.mjs');
  assert.equal((await buildHarnessKit(library, 'bugfix', [script.id, skill.id])).resources.length, 4);
});

function floor(view: Record<string, unknown>) { return { opora: { view: () => view } } as unknown as Floor; }
const connected = { connected: true, url: 'http://127.0.0.1:8740', project: { id: 'p1' }, workspace: 'w1' };
const fields = { goal: 'G', non_goals: 'N', acceptance: 'A', steps: [{ id: 's1' }] };

test('a verified kit goes into one card as a changeset that keeps the card\'s specification', async () => {
  const skill = await byPath('skills/ts-references/ts-references.item.json');
  let body: Record<string, any> | undefined;
  const client = () => ({
    changesetContext: async () => ({ acceptedHead: 'a'.repeat(40), graphDigest: 'g1', documents: [{ nodeId: 'k1', revision: 4, fields }], acceptedDocuments: [{ nodeId: 'k1' }] }),
    proposeChangeset: async (sent: unknown) => { body = sent as Record<string, any>; return { id: 'c1', accepted: false }; },
  });
  const result = await proposeKit(floor(connected), library, { card: oporaKey({ project: 'p1', workspace: 'w1' }, 'k1'), problem: 'bugfix', resources: [skill.id] }, client);
  assert.deepEqual(result, { id: 'c1', card: 'k1', resources: 4, opora: 'http://127.0.0.1:8740' });
  assert.equal(body!.parentRevision, 'a'.repeat(40));
  assert.equal(body!.expectedGraphDigest, 'g1');
  assert.equal(body!.changes[0].expectedRevision, 4);
  const sentFields = body!.changes[0].fields;
  assert.deepEqual({ ...sentFields, harness: undefined }, { ...fields, harness: undefined }, 'goal, non-goals, acceptance and steps travel unchanged');
  assert.equal(sentFields.harness.schema, 'harness.kit/1');
  assert.equal(sentFields.harness.resources.length, 4);
});

test('a card is proposed only on a bound floor, from its own plan, with an accepted specification', async () => {
  const skill = await byPath('skills/ts-references/ts-references.item.json');
  const card = oporaKey({ project: 'p1', workspace: 'w1' }, 'k1');
  const client = (documents: unknown[], accepted: unknown[]) => () => ({
    changesetContext: async () => ({ acceptedHead: 'a'.repeat(40), graphDigest: 'g', documents, acceptedDocuments: accepted }) as never,
    proposeChangeset: async () => { throw new Error('must not propose'); },
  });
  const input = { card, problem: 'bugfix', resources: [skill.id] };
  await assert.rejects(proposeKit(floor({ connected: false }), library, input, client([], [])), /není připojené/);
  await assert.rejects(proposeKit(floor(connected), library, { ...input, card: oporaKey({ project: 'p1', workspace: 'other' }, 'k1') }, client([], [])), /připojeného projektu/);
  await assert.rejects(proposeKit(floor(connected), library, input, client([{ nodeId: 'k1', revision: 1, fields }], [])), /přijaté zadání/);
});
