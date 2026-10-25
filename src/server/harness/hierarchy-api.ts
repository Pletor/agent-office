import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessBindings, parseBindingPlace } from './bindings.js';
import { HarnessError, HarnessProfiles, parseHarnessLayer } from './profiles.js';
import { hierarchyAbout, hierarchyContext, oporaOrigin } from './hierarchy-context.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { harnessHandoff } from './handoff.js';
import { HarnessRegistry } from './registry.js';
import { harnessLevel, resolveHarness, type HarnessLevel } from '../../shared/harness-cascade.js';
import { samePlace } from '../../shared/opora-identity.js';
import { originHistory } from './origin-history.js';

export interface HierarchyAuthority { local: boolean; writable: boolean; globalWrite: boolean; actor: string }
export function harnessProjects(ctx: Ctx) {
  return [...ctx.floors.values()].map(floor => {
    const view = floor.opora.view();
    return { floor: floor.id, name: floor.info().name, projectName: view.project?.name ?? '', connected: view.connected };
  });
}
/** A saved profile is planning data. It never changes an execution's immutable assignment. */
export async function harnessHierarchyRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL, authority: HierarchyAuthority) {
  try {
    const store = new HarnessProfiles(ctx.cfg.dataDir);
    let target = url.searchParams.get('node') ?? '';
    let context = await hierarchyContext(ctx.cfg.dataDir, floor, target);
    if (url.searchParams.has('scope') && !harnessLevel(url.searchParams.get('scope'))) throw new HarnessError('Neplatná úroveň Harness.');
    let level = harnessLevel(url.searchParams.get('scope')) ?? context.path.at(-1)?.level ?? 'repository';
    if (url.searchParams.has('origin-history')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
      assertTarget(level, target, context.path.at(-1)?.level);
      const history = await originHistory(ctx.cfg.dataDir, floor, level, target);
      const latest = await hierarchyContext(ctx.cfg.dataDir, floor, target);
      if (latest.digest !== context.digest || latest.public.bindingRevision !== context.public.bindingRevision
        || oporaOrigin(latest.view.url) !== oporaOrigin(context.view.url)) throw new HarnessError('Hierarchie se změnila. Načtěte historii znovu.', 409);
      return send(res, 200, history, { 'cache-control': 'no-store' });
    }
    if (req.method === 'POST') {
      if (!authority.writable) throw new HarnessError('Konfiguraci mění pouze správce nebo jeho aktivní orchestrátor.', 403);
      const body = JSON.parse(await readBody(req, 300_000));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HarnessError('Očekává se objekt JSON.');
      if (body.op === 'bind') {
        const place = parseBindingPlace(body), view = floor.opora.view();
        if (!view.connected || !view.project || !view.workspace || !samePlace(place, { project: view.project.id, workspace: view.workspace })) throw new HarnessError('Připojit lze právě otevřený projekt a pracovní prostor Opory.', 409);
        await new HarnessBindings(ctx.cfg.dataDir).bind(floor.id, floor.dir, place, authority.actor,
          { revision: body.revision, rebind: body.rebind === true, baseUrl: oporaOrigin(view.url) });
        target = ''; level = 'repository'; context = await hierarchyContext(ctx.cfg.dataDir, floor, target);
      } else if (body.op === 'save') {
        level = harnessLevel(body.scope) ?? (() => { throw new HarnessError('Neplatná úroveň Harness.'); })();
        assertTarget(level, target, context.path.at(-1)?.level);
        if (level === 'global' && !authority.globalWrite) throw new HarnessError('Globální nastavení patří správci v kanceláři.', 403);
        const layer = parseHarnessLayer(body.layer);
        if (target && body.pathDigest !== context.digest) throw new HarnessError('Hierarchie se změnila. Načtěte ji znovu před uložením.', 409);
        // The registry's digest cache, as the handoff uses: without it every save re-hashed the whole catalog (~2 s).
        const library = new HarnessLibrary(harnessSources(floor.dir, authority.local), new HarnessRegistry(ctx.cfg.dataDir));
        await library.list();
        for (const binding of Object.values(layer)) if (binding && 'resource' in binding) {
          const entry = await library.read(binding.resource);
          if (!entry) throw new HarnessError('Prostředek není dostupný v tomto projektu: ' + binding.resource);
          if (level === 'global' && !['Harness handbook', 'Shared harness'].includes(entry.source)) throw new HarnessError('Globální prostředek musí být veřejně sdílený všem pracovníkům: ' + binding.resource);
        }
        const prospective = store.view(floor.dir, context.path);
        prospective.layers[level] = layer;
        prospective.effective = resolveHarness(level === 'global' ? { global: layer } : prospective.layers, prospective.path);
        await harnessHandoff(ctx.cfg.dataDir, floor.dir, target, authority.local, prospective);
        await store.save(floor.dir, context.path, level, layer, body.revision, authority.actor, async () => {
          const latest = await hierarchyContext(ctx.cfg.dataDir, floor, target);
          if (target && latest.digest !== body.pathDigest) throw new HarnessError('Hierarchie se během čekání změnila. Nic nebylo uloženo.', 409);
          context = latest; return latest.path;
        });
      } else throw new HarnessError('Neznámá operace Harness.');
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Use GET or POST' });
    assertTarget(level, target, context.path.at(-1)?.level);
    const view = store.view(floor.dir, context.path);
    if (level === 'global') view.effective = resolveHarness({ global: view.layers.global });
    let preview = '', warning = '';
    try { preview = await harnessHandoff(ctx.cfg.dataDir, floor.dir, target, authority.local, view); }
    catch (err) { warning = (err as Error).message; }
    return send(res, 200, { ...view, schema: 'harness.hierarchy/1', floor: floor.id, target, level,
      ...context.public, notice: context.notice, pathDigest: context.digest, choices: context.choices,
      writable: authority.writable && (level !== 'global' || authority.globalWrite), globalWrite: authority.globalWrite,
      canBind: authority.writable && context.view.connected && !!context.linked, preview, warning }, { 'cache-control': 'no-store' });
  } catch (err) { return send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message }); }
}
function assertTarget(level: HarnessLevel, target: string, own?: HarnessLevel) {
  if (target ? level !== own : !['global', 'repository'].includes(level)) throw new HarnessError('Vyberte uzel dané úrovně. Před uložením nelze zaměnit rodiče a kartu.');
}
