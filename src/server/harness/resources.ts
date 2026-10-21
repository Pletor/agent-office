// What the profile reply adds for the editor (docs/harness.md "Categories and the editor"): the state of
// every element the loaded layers assign, so a slot shows its element's title, revision and digest, or
// why it is unavailable (gone since, published in another project only, unknown), and the per-level
// audit filter the editor asks for (`?auditLevel=`).
import { HarnessLibrary, harnessSources } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { harnessLevel, pathNode, type HarnessPath, type HarnessProfile } from '../../shared/harness-cascade.js';
import type { HarnessResourceState } from '../../shared/harness.js';

/** The level (and node) whose own saves `?auditLevel=` asks for down `path`, or undefined for the latest saves of every level. */
export function ownAuditOf(url: URL, path: HarnessPath) {
  const level = harnessLevel(url.searchParams.get('auditLevel'));
  if (!level) return undefined;
  return { level, node: level === 'global' || level === 'project' ? '' : pathNode(path, level)?.node ?? '' };
}

/**
 * The state of each element the profile's layers assign, as the reader's library sees it (`local`: an
 * administrator's, with the machine folders). It never fails the reply: when the library can't be listed
 * the map is empty and the editor shows the IDs as they are.
 */
export async function assignedResources(dataDir: string, repo: string, local: boolean, profile: Pick<HarnessProfile, 'layers'>): Promise<Record<string, HarnessResourceState>> {
  const ids = [...new Set(Object.values(profile.layers).flatMap((layer) => Object.values(layer).flatMap((b) => (b && 'resource' in b ? [b.resource] : []))))];
  const out: Record<string, HarnessResourceState> = Object.create(null);
  if (!ids.length) return out;
  try {
    const library = new HarnessLibrary(harnessSources(repo, local), new HarnessRegistry(dataDir));
    await library.list();
    for (const id of ids.slice(0, 200)) {
      const found = library.resolve(id);
      if (found.status === 'available') {
        const e = found.entry;
        out[id] = { status: 'available', title: e.title, category: e.category, group: e.group, source: e.source, path: e.path, version: e.version, digest: e.digest };
      } else if (found.status === 'missing') {
        out[id] = { status: 'missing', title: found.title, category: found.category, source: found.source, path: found.path, version: found.version, digest: found.digest, missingSince: found.missingSince, lastSeenAt: found.lastSeenAt };
      } else out[id] = { status: 'unknown' };
    }
  } catch (err) { console.error('harness: the assigned elements could not be resolved: ' + (err as Error).message); }
  return out;
}
