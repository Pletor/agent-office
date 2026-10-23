import type http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { HarnessProfiles, HarnessError } from './profiles.js';
import { nativeHistory, noHistory } from './native-outcomes.js';
import { nativePairedHistory, noPairedHistory } from './native-paired.js';
import { recommendHarness, validateRecommendation } from './recommend.js';
import { oporaHarnessTask } from '../../shared/harness-cascade.js';

async function profile(dataDir: string, floor: Floor, task: string) {
  const module = new URL('./hierarchy-context.js', import.meta.url);
  const installed = existsSync(fileURLToPath(module)) || existsSync(fileURLToPath(module).replace(/\.js$/, '.ts'));
  if (installed && (!task || task.startsWith('opora:'))) {
    // Optional peer module: absent on legacy installations; an installed but broken resolver never falls back.
    const resolver = await import(module.href);
    const context = await resolver.hierarchyContext(dataDir, floor, task);
    return { view: new HarnessProfiles(dataDir).view(floor.dir, context.path), pathDigest: context.digest };
  }
  return { view: new HarnessProfiles(dataDir).view(floor.dir, task), pathDigest: '' };
}
const peerKey = (floor: Floor) => { const view = floor.opora.view(); return JSON.stringify([view.url, view.project?.id, view.workspace, view.connected]); };

export async function recommendationRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL, local: boolean) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  try {
    const problem = url.searchParams.get('problem') ?? '', capabilities = url.searchParams.getAll('capability');
    validateRecommendation(problem, capabilities);
    const task = url.searchParams.get('task') ?? '', view = floor.opora.view(), peer = peerKey(floor);
    if (task.startsWith('opora:') && (!view.project || !view.workspace || !task.startsWith(oporaHarnessTask(view.project.id, view.workspace, '')))) throw new HarnessError('Task is outside the linked project/workspace.', 403);
    const before = await profile(ctx.cfg.dataDir, floor, task);
    const [history, paired] = view.connected && view.project && view.workspace
      ? await Promise.all([nativeHistory(view.url, view.project.id, view.workspace), nativePairedHistory(view.url, view.project.id, view.workspace)])
      : [noHistory('floor-not-connected'), noPairedHistory('floor-not-connected')];
    const result = await recommendHarness(new HarnessLibrary(harnessSources(floor.dir, local)),
      problem, capabilities, before.view, history, paired);
    const after = await profile(ctx.cfg.dataDir, floor, task);
    if (peerKey(floor) !== peer || before.view.revision !== after.view.revision || before.pathDigest !== after.pathDigest) throw new HarnessError('Scope or profiles changed during preparation. Retry.', 409);
    return send(res, 200, { ...result, context: { task, project: view.project?.id ?? null, workspace: view.workspace, pathDigest: before.pathDigest } });
  } catch (err) { return send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message }); }
}
