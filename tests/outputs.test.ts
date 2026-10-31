import test from 'node:test';
import assert from 'node:assert/strict';
import { countOutputs, countsLine, imageAllowed, outputSection, parseOutputs, urlOf, type MergedPr } from '../src/shared/outputs.js';

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
