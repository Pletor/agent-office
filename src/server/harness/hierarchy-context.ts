import { createHash } from 'node:crypto';
import type { Floor } from '../floor.js';
import { HarnessBindings, bindingView } from './bindings.js';
import { HarnessError } from './profiles.js';
import { harnessCanvas } from './canvas.js';
import { harnessDeadEnd, harnessPath, harnessIndex, type HierarchyNode } from '../../shared/harness-hierarchy.js';
import { oporaKey, parseOporaKey, samePlace } from '../../shared/opora-identity.js';
import type { HarnessPath } from '../../shared/harness-cascade.js';
import type { HarnessChoice } from '../../shared/harness-navigation.js';

export function oporaOrigin(base: string): string {
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new HarnessError('Opora má neplatnou adresu serveru.', 503); }
}
export function hierarchyAbout(dataDir: string, floor: Floor) {
  const bindings = new HarnessBindings(dataDir), binding = bindings.forFloor(floor.id), view = floor.opora.view();
  const linked = view.project && view.workspace ? { project: view.project.id, workspace: view.workspace, name: view.project.name } : null;
  let notice = '';
  // Binding stays an explicit step (it decides where Page…Card equipment is saved); say which button and why levels are missing.
  if (!binding) notice = view.connected ? 'Připojte patro k projektu Opory tlačítkem „Připojit otevřenou Oporu“'
    + (linked ? ` (okno Opory je teď v projektu „${linked.name ?? linked.project}“)` : '')
    + '; teprve potom se zobrazí Stránka až Karta. Globální a projektová pravidla můžete upravovat už nyní.'
    : 'Opora není dostupná, patro proto zatím nelze připojit. Globální a projektová pravidla můžete upravovat už nyní.';
  else if (!view.connected) notice = 'Opora není dostupná. Specializace počkají na obnovení spojení.';
  else if (!samePlace(binding, linked ?? undefined) || (binding.baseUrl && binding.baseUrl !== oporaOrigin(view.url))) notice = 'Okno Opory čte jiný projekt, prostor nebo server než uložené připojení. Přepněte okno zpět nebo připojení změňte.';
  return { bindings, binding, linked, view, notice, public: { bound: bindingView(binding), linked,
    bindingRevision: bindings.revision(), notice } };
}
export function pathDigest(path: HarnessPath): string {
  return createHash('sha256').update(JSON.stringify(path.map(p => [p.level, p.node]))).digest('hex');
}
export async function hierarchyContext(dataDir: string, floor: Floor, target: string) {
  const about = hierarchyAbout(dataDir, floor);
  let nodes: HierarchyNode[] = [], notice = about.notice;
  if (!notice && about.binding) {
    try { nodes = await harnessCanvas(about.view.url, about.binding); }
    catch (err) { if (target) throw err; notice = (err as Error).message; }
    const latest = hierarchyAbout(dataDir, floor);
    if (latest.notice || !samePlace(about.binding, latest.binding) || latest.binding?.baseUrl !== about.binding.baseUrl) throw new HarnessError('Připojení se během načítání změnilo. Načtěte konfiguraci znovu.', 409);
  }
  if (target && (!about.binding || notice)) throw new HarnessError(notice || 'Patro není připojené.', 503);
  const index = harnessIndex(nodes);
  let path: HarnessPath = [];
  if (target && about.binding) {
    const parsed = parseOporaKey(target);
    if (!parsed || !samePlace(parsed, about.binding) || oporaKey(parsed, parsed.nodeId) !== target) throw new HarnessError('Uzel nepatří do připojeného projektu a prostoru.', 403);
    if (!nodes.some(n => n.id === parsed.nodeId)) throw new HarnessError('Uzel už na plátně není.', 404);
    const dead = harnessDeadEnd(nodes, parsed.nodeId, index);
    if (dead) throw new HarnessError(dead);
    path = harnessPath(nodes, about.binding, parsed.nodeId, index);
    if (path.at(-1)?.node !== target) throw new HarnessError('Tento uzel nemá samostatnou úroveň Harness. Použijte úroveň projektu.');
  }
  const choices: HarnessChoice[] = [];
  if (about.binding) for (const node of nodes) {
    if (harnessDeadEnd(nodes, node.id, index)) continue;
    const chain = harnessPath(nodes, about.binding, node.id, index), own = chain.at(-1);
    if (!own || own.node !== oporaKey(about.binding, node.id)) continue;
    choices.push({ key: own.node, name: node.name, level: own.level,
      ancestry: Object.fromEntries(chain.map(item => [item.level, item.node])) });
  }
  return { ...about, nodes, path, choices, notice, digest: pathDigest(path) };
}
