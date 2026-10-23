// The design addendum a design card's worker gets (src/server/opora/design-brief.ts): its sketches,
// the design system by mode (brand follows DESIGN.md, explore leaves it aside), and the screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROMPTS, type PromptId } from '../src/shared/prompts.js';
import { OporaError, type OporaClient } from '../src/server/opora/client.js';
import { designAddendum, prepareDesignBrief, type DesignFindings } from '../src/server/opora/design-brief.js';
import { DESIGN_MD_CAP, readRepoDesignMd } from '../src/server/opora/design-system.js';

const where = { base: 'http://127.0.0.1:8740', project: 'p1', workspace: 'draft', previews: '/data/opora-previews/p1/c1' };
const card = { id: 'c1', name: 'Cart page', group: 'design' };
const DESIGN_MD = '# Shop design\n\n## Fonts\nInter 16/24\n\n## Colours\n--brand: #9b5de5\n';
const findings = (over: Partial<DesignFindings> = {}): DesignFindings => ({
  sketches: { drawing: { elements: 4, images: 1 } }, inspiration: { images: 2, materials: 0 }, mode: 'brand',
  designSystem: { text: DESIGN_MD, source: 'repo', truncated: false, bytes: DESIGN_MD.length }, ...over,
});

test('brand mode puts DESIGN.md in the addendum and says to follow it exactly', () => {
  const out = designAddendum(PROMPTS['opora.design'].text, card, findings(), where);
  assert.match(out, /a drawing of 4 elements \(1 pasted image\)/);
  assert.match(out, /2 inspiration images/);
  assert.match(out, /api\/layout-preview\?project=p1&workspace=draft&layer=c1/);
  assert.match(out, /Design mode: brand\. Follow the project's DESIGN\.md/);
  assert.match(out, /--brand: #9b5de5/);
  assert.match(out, /light and dark × mobile \(390×844\) and desktop \(1440×900\)/);
  assert.match(out, /at most 8 PNGs/);
  assert.ok(out.includes(path.join('/data/opora-previews/p1/c1', '<head-sha>')));
});

test('a long DESIGN.md goes by pointer with its sections, and a cut one says so', () => {
  const long = '# Shop\n## Fonts\n' + 'x'.repeat(9000) + '\n## Buttons\n';
  const out = designAddendum(PROMPTS['opora.design'].text, card, findings({ designSystem: { text: long, source: 'repo', truncated: true, bytes: 90_000 } }), where);
  assert.match(out, /git show HEAD:DESIGN\.md/);
  assert.match(out, /Its sections: Shop; Fonts; Buttons/);
  assert.match(out, /cut at 64 kB of 88 kB/);
  assert.doesNotMatch(out, /xxxxxxxxxx/);
});

test('explore mode leaves DESIGN.md out and asks for a proposed one', () => {
  const out = designAddendum(PROMPTS['opora.design'].text, card, findings({ mode: 'explore', designSystem: undefined }), where);
  assert.match(out, /Design mode: explore/);
  assert.match(out, /Do NOT use the project's existing DESIGN\.md/);
  assert.match(out, /design\/proposals\/c1\/DESIGN\.md/);
  assert.doesNotMatch(out, /--brand: #9b5de5/);
});

test('brand mode without a DESIGN.md asks for one derived from the existing UI, as a proposal', () => {
  const out = designAddendum(PROMPTS['opora.design'].text, card, findings({ designSystem: undefined }), where);
  assert.match(out, /no DESIGN\.md yet/);
  assert.match(out, /derive|write down that style/);
  assert.match(out, /design\/proposals\/c1\/DESIGN\.md/);
});

test('a card that is not a design card gets no addendum, and reads nothing', async () => {
  let reads = 0;
  const client = new Proxy({}, { get: () => () => { reads++; return Promise.resolve(undefined); } }) as unknown as OporaClient;
  const out = await prepareDesignBrief({ client, prompt: (id) => PROMPTS[id].text, card: { ...card, group: 'dev' }, base: where.base, project: 'p1', workspace: 'draft', repoDir: '.', dataDir: '.' });
  assert.equal(out, '');
  assert.equal(reads, 0);
});

const notFound = async () => { throw new OporaError(404, 'nope'); };

function fakeClient(node: Record<string, unknown>, designSystem: () => Promise<unknown>, reviewPreview: () => Promise<unknown> = notFound) {
  const asked: string[] = [];
  const client = {
    reviewPreview: async () => { asked.push('review-preview'); return reviewPreview(); },
    drawing: async () => ({ elements: [{ type: 'rectangle' }] }),
    storyboard: async () => ({ animation: 'kod', moments: [{ id: 'm1', t: 0 }] }),
    rawNode: async () => node,
    designSystem: async () => { asked.push('design-system'); return designSystem(); },
  } as unknown as OporaClient;
  return { client, asked };
}

function repo(t: { after(fn: () => void): void }, design?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-design-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'README.md'), 'x');
  if (design !== undefined) writeFileSync(path.join(dir, 'DESIGN.md'), design);
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

test('the addendum is the ⚙️ Settings prompt, read when the card is taken', async (t) => {
  const asked: PromptId[] = [];
  const prompt = (id: PromptId) => { asked.push(id); return 'CUSTOM {{card}} · {{found}}\n{{designSystem}}'; };
  const { client } = fakeClient({ id: 'c1', blocks: [{ images: ['a', 'b'] }], materials: [{}] }, async () => { throw new OporaError(404, 'nope'); });
  const out = await prepareDesignBrief({ client, prompt, card, base: where.base, project: 'p1', workspace: 'draft', repoDir: repo(t, DESIGN_MD), dataDir: '.' });
  assert.deepEqual(asked, ['opora.design']);
  assert.match(out, /^CUSTOM Cart page · On Opora this card has a drawing of 1 element/);
  assert.match(out, /2 inspiration images, 1 attachment/);
  // Opora has no design-system endpoint yet (404): the repo's committed DESIGN.md stands in.
  assert.match(out, /repository's committed DESIGN\.md/);
  assert.match(out, /--brand: #9b5de5/);
});

test('Opora\'s design system wins when it has one, and an explore card never asks for it', async (t) => {
  const dir = repo(t, DESIGN_MD);
  const served = fakeClient({ id: 'c1' }, async () => ({ markdown: '# From Opora\n--brand: teal' }));
  const out = await prepareDesignBrief({ client: served.client, prompt: (id) => PROMPTS[id].text, card, base: where.base, project: 'p1', workspace: 'draft', repoDir: dir, dataDir: '.' });
  assert.match(out, /Opora's design system for this project/);
  assert.match(out, /--brand: teal/);
  const explore = fakeClient({ id: 'c1', design: { mode: 'explore' } }, async () => ({ markdown: '# From Opora' }));
  const out2 = await prepareDesignBrief({ client: explore.client, prompt: (id) => PROMPTS[id].text, card, base: where.base, project: 'p1', workspace: 'draft', repoDir: dir, dataDir: '.' });
  assert.deepEqual(explore.asked, ['review-preview']);
  assert.match(out2, /Design mode: explore/);
  assert.doesNotMatch(out2, /--brand/);
});

test('DESIGN.md is read as committed at HEAD and capped', (t) => {
  const dir = repo(t, DESIGN_MD);
  writeFileSync(path.join(dir, 'DESIGN.md'), 'uncommitted edit');
  assert.equal(readRepoDesignMd(dir)?.text, DESIGN_MD);
  assert.equal(readRepoDesignMd(repo(t)), undefined);
  const big = readRepoDesignMd(repo(t, 'y'.repeat(DESIGN_MD_CAP + 10)))!;
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, DESIGN_MD_CAP);
});

const prep = (client: OporaClient, repoDir = '.') => prepareDesignBrief({ client, prompt: (id) => PROMPTS[id].text, card, base: where.base, project: 'p1', workspace: 'draft', repoDir, dataDir: '.' });

test('the mode comes from Opora’s review-preview first, over the node’s own', async () => {
  const f = fakeClient({ id: 'c1', design: { mode: 'brand' } }, async () => ({ available: true, markdown: DESIGN_MD }), async () => ({ design: { mode: 'explore', revision: 2 } }));
  const out = await prep(f.client);
  assert.match(out, /Design mode: explore/);
  assert.match(out, /"designMdSha256":null/);
  assert.ok(!f.asked.includes('design-system'));
});

test('no review-preview record is brand, and brand cites DESIGN.md by revision and sha256', async () => {
  const sha = 'a'.repeat(64);
  const f = fakeClient({ id: 'c1' }, async () => ({ available: true, markdown: DESIGN_MD, sha256: sha, revision: 'b'.repeat(40), bytes: 60 }), async () => ({ design: { mode: 'brand', revision: 0 } }));
  const out = await prep(f.client);
  assert.match(out, /Design mode: brand\. Follow the project's DESIGN\.md · rev bbbbbbbbbbbb · sha256 aaaaaaaaaaaa/);
  assert.match(out, new RegExp(`"designMdSha256":"${sha}"`));
  assert.match(out, /preview\.json/);
});

for (const [why, fail] of [['404 (not deployed)', notFound], ['428 (no identity)', async () => { throw new OporaError(428, 'identity_required'); }], ['an answer without a mode', async () => ({ available: false })]] as const) {
  test(`review-preview ${why} falls back to the node's design.mode, then to brand`, async (t) => {
    const fromNode = await prep(fakeClient({ id: 'c1', design: { mode: 'explore' } }, notFound, fail).client);
    assert.match(fromNode, /Design mode: explore/);
    const dir = repo(t, DESIGN_MD);
    const fallback = await prep(fakeClient({ id: 'c1' }, async () => ({ available: false, file: 'DESIGN.md', reason: 'missing' }), fail).client, dir);
    assert.match(fallback, /Design mode: brand/);
    // Opora said it has no DESIGN.md (available: false): the repo's committed one stands in, with its fingerprint.
    assert.match(fallback, /repository's committed DESIGN\.md/);
    assert.match(fallback, /"designMdSha256":"[a-f0-9]{64}"/);
  });
}
