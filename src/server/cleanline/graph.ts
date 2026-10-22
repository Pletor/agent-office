// 🧹 The commit graph of the clean line: the last commits of the remote main, and every branch's and
// open PR's commits that main doesn't have yet, read with git log (fixed arguments, no shell).
import { layoutGraph, prOfSubject, refsOf, topoOrder, type GraphCommit, type GraphRow } from '../../shared/cleanline.js';
import type { Runner } from '../status/git.js';

export const MAIN_COMMITS = 120;
const SIDE_COMMITS = 300;
const MAX_HEADS = 40;
const FORMAT = '--format=%H%x1f%P%x1f%s%x1f%an%x1f%ct%x1f%D%x1e';

/** git log output in FORMAT, as commits. */
export function parseLog(out: string, main: boolean): GraphCommit[] {
  const list: GraphCommit[] = [];
  for (const rec of out.split('\x1e')) {
    const [sha, parents, subject = '', author = '', time = '0', deco = ''] = rec.replace(/^\s+/, '').split('\x1f');
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    const pr = prOfSubject(subject);
    list.push({ sha, parents: parents ? parents.split(' ').filter(Boolean) : [], subject, author, time: Number(time) || 0, refs: refsOf(deco), main, ...(pr ? { pr } : {}) });
  }
  return list;
}

/** The graph: `remoteRef`'s last commits, and the commits of `heads` (refs) that aren't in it. */
export async function readGraph(run: Runner, dir: string, remoteRef: string, heads: readonly string[]): Promise<{ rows: GraphRow[]; lanes: number }> {
  const main = parseLog(await run('git', ['log', '--topo-order', `-n${MAIN_COMMITS}`, FORMAT, remoteRef, '--'], dir).catch(() => ''), true);
  const picked = heads.slice(0, MAX_HEADS);
  const side = picked.length ? parseLog(await run('git', ['log', '--topo-order', `-n${SIDE_COMMITS}`, FORMAT, ...picked, '--not', remoteRef, '--'], dir).catch(() => ''), false) : [];
  return layoutGraph(topoOrder([...side, ...main]));
}
