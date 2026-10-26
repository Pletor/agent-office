import { createHash } from 'node:crypto';
import { HarnessLibrary } from './catalog.js';
import { HarnessError } from './profiles.js';
import type { HarnessKit } from '../../shared/harness-kit.js';
import type { HarnessText } from '../../shared/harness.js';
import { isItemPath, itemParts, parseItem } from './items.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/;
const validId = (value: string) => ID.test(value) && value.trim() === value;
/** Match Python's ensure_ascii JSON limit, including escaped Unicode and UTF-16 surrogate pairs. */
export function kitBytes(kit: HarnessKit): number {
  return Buffer.byteLength(JSON.stringify(kit).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
}
/** Read through the existing secure catalog, never from caller-supplied paths. */
export async function buildHarnessKit(library: HarnessLibrary, problem: string, ids: string[]): Promise<HarnessKit> {
  if (!validId(problem)) throw new HarnessError('Choose a problem identifier of 1-200 characters.');
  if (ids.length > 24 || new Set(ids).size !== ids.length || ids.some(id => !validId(id))) throw new HarnessError('Choose at most 24 distinct catalog resource IDs.');
  const catalog = await library.list();
  const kit: HarnessKit = { schema: 'harness.kit/1', problems: [problem], resources: [] };
  const canonical = new Set<string>();
  const chosen: HarnessText[] = [], requires = new Map<string, string[]>();
  for (const id of ids) {
    const entry = await library.read(id);
    if (!entry) throw new HarnessError('Resource is unavailable for this worker: ' + id, 404);
    if (canonical.has(entry.id)) throw new HarnessError('Select each canonical resource only once: ' + entry.id);
    canonical.add(entry.id); chosen.push(entry);
  }
  // A definition brings its parts (docs/harness-items.md): each pinned by its own digest, after it, once.
  for (const entry of [...chosen]) {
    if (!isItemPath(entry.path)) continue;
    let parts;
    try {
      const item = parseItem(entry.text, entry.category);
      parts = itemParts(item, entry, catalog.entries).map(part => ({ ...part, node: item.run?.runner === 'node' && part.role === 'script' && part.entry.category === 'scripts' }));
    } catch (err) { throw new HarnessError('Definition ' + entry.path + ' is invalid: ' + (err as Error).message); }
    for (const part of parts) {
      if (part.node) requires.set(part.entry.id, ['command:node']);
      if (canonical.has(part.entry.id)) continue;
      const text = await library.read(part.entry.id);
      if (!text) throw new HarnessError('Resource is unavailable for this worker: ' + part.entry.id, 404);
      canonical.add(text.id); chosen.push(text);
    }
  }
  if (chosen.length > 24) throw new HarnessError(`Harness kit with the definitions' parts has ${chosen.length} resources; at most 24.`);
  for (const entry of chosen) {
    const id = entry.id;
    if (entry.text.includes('\0') || [...entry.text].some(c => { const code = c.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) throw new HarnessError('Resource is not valid UTF-8 text: ' + id);
    kit.resources.push({ slot: entry.category + '.' + createHash('sha256').update(entry.id).digest('hex'),
      resource: entry.id, category: entry.category, digest: createHash('sha256').update(entry.text, 'utf8').digest('hex'),
      content: entry.text, requires: requires.get(entry.id) ?? [] });
    if (kitBytes(kit) > 96 * 1024) throw new HarnessError('Harness kit exceeds 96 KiB including metadata and Unicode escapes.');
  }
  return kit;
}
