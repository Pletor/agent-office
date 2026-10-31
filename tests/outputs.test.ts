import test from 'node:test';
import assert from 'node:assert/strict';
import { countOutputs, countsLine, diaryUrl, EXPLANATION_MAX, imageAllowed, outputSection, parseOutputs, urlOf, type MergedPr } from '../src/shared/outputs.js';

test('a PR body without a ## Výstup section has no outputs', () => {
  assert.equal(parseOutputs(undefined), undefined);
  assert.equal(parseOutputs(''), undefined);
  assert.equal(parseOutputs('## Summary\nArtefakt: https://claude.ai/artifact/x\n'), undefined, 'the keys count only inside the section');
  assert.equal(parseOutputs('## Výstup\n\nnic tu není\n## Další'), undefined, 'a section with no valid line is "bez výstupu"');
});

test('the section reads artifact, before, after and diagrams, and ends at the next heading', () => {
  const body = [
    '## Summary', 'text', '',
    '## Výstup  ',
    '- Artefakt: <https://claude.ai/artifact/abc>',
    'Před: ![](https://github.com/user-attachments/assets/before-1)',
    'Po: <img width="600" alt="po" src="https://private-user-images.githubusercontent.com/1/after.png?jwt=x">',
    '### detail',
    'Diagram: ![lens](https://raw.githubusercontent.com/o/r/sha/docs/obrazky/lens.gif "Lens")',
    '* Diagram: [PR Lens](https://claude.ai/artifact/lens)',
    'Po: ![](https://github.com/user-attachments/assets/ignored-second)',
    '## Test plan',
    'Diagram: ![](https://github.com/x.png)',
  ].join('\r\n');
  const o = parseOutputs(body)!;
  assert.deepEqual(o.artifacts, ['https://claude.ai/artifact/abc']);
  assert.deepEqual(o.before, { url: 'https://github.com/user-attachments/assets/before-1', image: true });
  assert.deepEqual(o.after, { url: 'https://private-user-images.githubusercontent.com/1/after.png?jwt=x', image: true }, 'the first Po wins, an <img> counts as a picture');
  assert.deepEqual(o.diagrams, [
    { url: 'https://raw.githubusercontent.com/o/r/sha/docs/obrazky/lens.gif', image: true },
    { url: 'https://claude.ai/artifact/lens', image: false },
  ], '### stays in the section, a plain link is not a picture, ## Test plan ends it');
});

test('pictures from other hosts, or over http, show only as links', () => {
  const o = parseOutputs('## výstup\nPřed: ![](https://evil.example/x.png)\nPo: ![](http://github.com/x.png)\nDiagram: https://imgur.com/a.gif\nPred: ![](https://github.com/ignored)')!;
  assert.deepEqual(o.before, { url: 'https://evil.example/x.png', image: false });
  assert.deepEqual(o.after, { url: 'http://github.com/x.png', image: false });
  assert.deepEqual(o.diagrams, [{ url: 'https://imgur.com/a.gif', image: false }]);
  assert.equal(imageAllowed('https://claude.ai/a.png'), true);
  assert.equal(imageAllowed('https://user-images.githubusercontent.com/a.png'), true);
  assert.equal(imageAllowed('https://github.com.evil.example/a.png'), false);
  assert.equal(imageAllowed('javascript:alert(1)'), false);
});

test('only http(s) URLs are taken', () => {
  assert.equal(urlOf('![](javascript:alert(1))'), undefined);
  assert.equal(parseOutputs('## Výstup\nArtefakt: [x](javascript:alert(1))\nPo: data:image/png;base64,AAA'), undefined);
  assert.deepEqual(urlOf('[a](https://claude.ai/artifact/1) and https://x.y'), { url: 'https://claude.ai/artifact/1', picture: false });
});

test('outputSection finds the heading case-insensitively and stops at # or ##', () => {
  assert.deepEqual(outputSection('# T\n## VÝSTUP\na\nb\n# Konec\nc'), ['a', 'b']);
  assert.equal(outputSection('### Výstup\na'), undefined);
});

test('counts say how many merged PRs have outputs', () => {
  const pr = (n: number, out: boolean): MergedPr => ({ number: n, title: '', author: '', mergedAt: '', commits: [], ...(out ? { outputs: { artifacts: ['https://claude.ai/a'], diagrams: [] } } : {}) });
  const c = countOutputs([pr(1, true), pr(2, false), pr(3, true)]);
  assert.deepEqual(c, { merged: 3, with: 2, without: 1 });
  assert.equal(countsLine(c), '3 PR · 2 s výstupem · 1 bez');
});

test('Vysvětlení is plain text: joined, trimmed, capped, no URL taken, and enough to count as an output', () => {
  const o = parseOutputs('## Výstup\n- Vysvětlení:   Karta ukazuje <b>deník</b> https://evil.example/x  \nVysvetleni: druhý řádek\n## Jinde\nVysvětlení: ne')!;
  assert.equal(o.explanation, 'Karta ukazuje <b>deník</b> https://evil.example/x druhý řádek');
  assert.deepEqual(o.artifacts, []);
  assert.deepEqual(o.diagrams, []);
  assert.equal(o.before, undefined);
  const long = parseOutputs(`## Výstup\nVysvětlení: ${'a'.repeat(400)}\nVysvětlení: ${'b'.repeat(400)}`)!;
  assert.equal(long.explanation!.length, EXPLANATION_MAX);
  assert.equal(parseOutputs('## Výstup\nVysvětlení:   \n'), undefined, 'an empty explanation is no output');
  const nfd = parseOutputs('## Výstup\nVysvětlení: rozložené znaky')!;
  assert.equal(nfd.explanation, 'rozložené znaky');
  assert.equal(parseOutputs('## Výstup\nArtefakt: https://claude.ai/artifact/a')!.explanation, undefined);
});

test('diaryUrl keeps only https://claude.ai/artifact/… and lets an empty string clear it', () => {
  assert.equal(diaryUrl('  https://claude.ai/artifact/abc-1  '), 'https://claude.ai/artifact/abc-1');
  assert.equal(diaryUrl(''), '');
  assert.equal(diaryUrl('   '), '');
  for (const bad of ['http://claude.ai/artifact/a', 'https://evil.ai/artifact/a', 'https://claude.ai/chat/a', 'https://claude.ai/artifact/', 'javascript:alert(1)', 'https://u:p@claude.ai/artifact/a', 42, null, undefined]) {
    assert.equal(diaryUrl(bad), undefined, String(bad));
  }
});
