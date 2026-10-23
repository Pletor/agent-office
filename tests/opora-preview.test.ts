import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDesignMd, previewOf, previewFileUrl } from '../src/shared/opora-preview.ts';
import { MAX_PNG, PreviewReader, sketchCounts } from '../src/server/opora/preview-reader.ts';
import { designStage, evidence, type StageInput } from '../src/client/features/design-preview/stage.ts';

const MD = `# Shop — DESIGN.md

## Typografie
- Font family: 'Nunito', system-ui, sans-serif
- Písmo nadpisů: \`Space Grotesk\`
- font: "<script>alert(1)</script>"

## Barvy
| token | hodnota |
|---|---|
| ink | #1F2230 |
| akcent | \`#ff8a5b\` |
- plocha: #fff
- url(javascript:alert(1)) #12345g
Again ink #1f2230
`;

test('parseDesignMd finds font names and hex swatches, never markup', () => {
  const b = parseDesignMd(MD);
  assert.deepEqual(b.fonts, ['Nunito', 'Space Grotesk']);
  assert.deepEqual(b.colors, [{ hex: '#1f2230', name: 'ink' }, { hex: '#ff8a5b', name: 'akcent' }, { hex: '#fff', name: 'plocha' }]);
  assert.deepEqual(parseDesignMd(42), { fonts: [], colors: [] });
  const many = parseDesignMd(Array.from({ length: 30 }, (_, i) => `c${i}: #${String(i).padStart(6, '0')}`).join('\n'));
  assert.equal(many.colors.length, 8);
});

const SHA = 'a'.repeat(40), MDSHA = 'b'.repeat(64);
const raw = {
  nodeId: 'card', secret: 'x',
  design: { mode: 'explore', revision: 2, by: 'human' },
  designSystem: { available: true, file: 'DESIGN.md', revision: 'c0ffee1234', sha256: MDSHA, bytes: 10, markdown: 'ignored here' },
  sketchUrl: '/api/layout-preview?project=p&workspace=w&layer=card',
  heads: [
    { executionId: 'e', prNumber: 7, headSha: SHA, prState: 'open', current: true, mode: 'explore', designMdSha256: null, proposedDesignMd: 'font: Inter\naccent: #5b3df5',
      confirmed: { by: 'human', at: '2026-10-23T10:00:00Z' },
      screenshots: [
        { label: 'mobil světlý', viewport: { width: 390, height: 844 }, stage: 'kontroly', fileId: 'preview_' + 'c'.repeat(64), url: 'javascript:alert(1)' },
        { label: 'bad id', fileId: '../../etc/passwd' },
        { label: '', fileId: 'preview_x' },
      ] },
    'junk',
  ],
};

test('previewOf whitelists the preview: mode, DESIGN.md reference, sketch, heads and shots', () => {
  const p = previewOf(raw, { available: true, revision: 'c0ffee1234', sha256: MDSHA, markdown: MD });
  assert.equal(p.mode, 'explore');
  assert.equal(p.sketch, true);
  assert.deepEqual(p.designSystem, { available: true, revision: 'c0ffee1234', sha256: MDSHA, brand: parseDesignMd(MD) });
  assert.equal(p.heads.length, 1);
  const h = p.heads[0];
  assert.equal(h.prNumber, 7);
  assert.equal(h.headSha, SHA);
  assert.equal(h.designMdSha256, undefined);
  assert.deepEqual(h.proposed, { fonts: ['Inter'], colors: [{ hex: '#5b3df5', name: 'accent' }] });
  assert.deepEqual(h.confirmed, { by: 'human', at: '2026-10-23T10:00:00Z' });
  assert.deepEqual(h.shots, [{ label: 'mobil světlý', file: 'preview_' + 'c'.repeat(64), width: 390, height: 844, stage: 'kontroly' }], 'no url, no bad ids');
  assert.ok(!JSON.stringify(p).includes('secret') && !JSON.stringify(p).includes('javascript'));
  assert.equal(previewOf({ design: { mode: 'weird' } }).mode, 'brand');
  assert.equal(previewFileUrl('f1', 'card', 'shot', 'preview_1'), '/api/opora-preview/file?floor=f1&card=card&kind=shot&file=preview_1');
});

const where = { base: 'http://opora.test', agent: 'office-f1', project: 'p', workspace: 'w' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')]);

function fakeOpora(routes: Record<string, () => Response>) {
  const seen: { url: string; method?: string; actor?: string }[] = [];
  const f = (async (u: URL | string, init?: RequestInit) => {
    const url = new URL(String(u));
    seen.push({ url: url.pathname + url.search, method: init?.method, actor: (init?.headers as Record<string, string>)?.['X-Opora-Actor'] });
    const r = routes[url.pathname];
    return r ? r() : new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}
const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

test('PreviewReader reads with GET only, caches, and an Opora without the endpoint is "missing"', async () => {
  const none = fakeOpora({});
  const r0 = await new PreviewReader(none.f).card(where, 'card');
  assert.equal(r0.state, 'missing');
  assert.deepEqual(r0.heads, []);
  const o = fakeOpora({ '/api/oporahub/review-preview': json(raw), '/api/oporahub/design-system': json({ available: true, revision: 'c0ffee1234', sha256: MDSHA, markdown: MD }),
    '/api/drawing': json({ scene: { elements: [{}, {}, { isDeleted: true }] } }), '/api/storyboard': json({ storyboard: { moments: [{ sketch: 'x' }, {}] } }) });
  const reader = new PreviewReader(o.f);
  const r = await reader.card(where, 'card');
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.drawing, { elements: 2 });
  assert.deepEqual(r.storyboard, { moments: 2, sketches: 1 });
  assert.deepEqual(r.designSystem?.brand?.fonts, ['Nunito', 'Space Grotesk']);
  const n = o.seen.length;
  await reader.card(where, 'card');
  assert.equal(o.seen.length, n, 'cached for 30 s');
  assert.ok(o.seen.every((s) => s.method === 'GET' && s.actor === 'agent; name=office-f1'));
  assert.deepEqual(sketchCounts({ status: 413, big: true }, { status: 404 }), { drawing: { elements: 1 } });
});

test('PreviewReader serves only listed screenshots as PNG and sketches as SVG, capped', async () => {
  const fileId = 'preview_' + 'c'.repeat(64);
  const ok = fakeOpora({ '/api/oporahub/review-preview': json(raw), '/api/oporahub/review-preview/file': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    '/api/layout-preview': () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } }) });
  const reader = new PreviewReader(ok.f);
  assert.deepEqual(await reader.file(where, 'card', 'shot', fileId), { status: 200, type: 'image/png', body: PNG });
  assert.equal((await reader.file(where, 'card', 'shot', 'preview_other')).status, 404, 'not listed for this card');
  assert.equal((await reader.file(where, 'card', 'shot', '../x')).status, 400);
  assert.equal((await reader.file(where, 'card', 'sketch')).type, 'image/svg+xml');
  const lyingPng = fakeOpora({ '/api/oporahub/review-preview': json(raw), '/api/oporahub/review-preview/file': () => new Response('<html>', { headers: { 'content-type': 'image/png' } }) });
  assert.equal((await new PreviewReader(lyingPng.f).file(where, 'card', 'shot', fileId)).status, 502);
  const html = fakeOpora({ '/api/layout-preview': () => new Response('<svg/>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal((await new PreviewReader(html.f).file(where, 'card', 'sketch')).status, 502);
  const big = fakeOpora({ '/api/oporahub/review-preview': json(raw), '/api/oporahub/review-preview/file': () => new Response(Buffer.concat([PNG, Buffer.alloc(MAX_PNG)]), { headers: { 'content-type': 'image/png' } }) });
  assert.equal((await new PreviewReader(big.f).file(where, 'card', 'shot', fileId)).status, 413);
});

test('designStage and evidence follow the card, its lane and its preview', () => {
  const base: StageInput = { phase: 0, moved: false, working: false };
  const p = { linked: true, nodeId: 'c', state: 'ok' as const, mode: 'brand' as const, sketch: false, heads: [] };
  assert.equal(designStage(base), 0);
  assert.equal(designStage({ ...base, preview: { ...p, sketch: true } }), 1);
  assert.equal(designStage({ ...base, preview: { ...p, sketch: true, storyboard: { moments: 4, sketches: 0 } } }), 2);
  assert.equal(designStage({ ...base, branch: 'opora/x' }), 3);
  const head = { current: true, mode: 'brand' as const, headSha: SHA, prNumber: 9, designMdSha256: MDSHA, shots: [{ label: 'mobil', file: 'preview_1' }] };
  const withShots = { ...p, sketch: true, designSystem: { available: true, sha256: MDSHA }, heads: [head] };
  assert.equal(designStage({ ...base, preview: withShots }), 4);
  assert.equal(designStage({ ...base, stage: 'Shoda s návrhem', preview: withShots }), 5);
  assert.equal(designStage({ ...base, phase: 4, moved: true }), 5);
  assert.equal(designStage({ ...base, status: 'closed' }), 6);
  assert.equal(designStage({ ...base, preview: { ...withShots, heads: [{ ...head, confirmed: { by: 'human' } }] } }), 6);
  const ev = Object.fromEntries(evidence({ ...base, preview: withShots }, 5).map((e) => [e.name, [e.state, e.note]]));
  assert.deepEqual(ev['Kód existuje'], ['full', 'PR #9']);
  assert.deepEqual(ev['Screenshoty'], ['full', '1 · aaaaaaa']);
  assert.deepEqual(ev['Soulad s brandem'], ['full', 'podle DESIGN.md']);
  assert.deepEqual(ev['Shoda s návrhem'], ['half', 'hlásí agent']);
  assert.deepEqual(ev['Potvrzeno člověkem'], ['none', undefined]);
  const exp = evidence({ ...base, preview: { ...withShots, mode: 'explore' } }, 5).map((e) => e.name);
  assert.ok(exp.includes('Nový směr') && !exp.includes('Soulad s brandem'));
});
