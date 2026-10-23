// The part of the orchestrator's overview about where its card is in the project's architecture and
// what the page is on Opora: the way down to it from the 🎚️ switchboard (environment › domain › page ›
// subpage), the page's settings (what it's for, its route, its source file, goal, non-goals,
// acceptance, plan steps), the project's settings, and the areas, sectors and nodes already laid out
// inside the page on the canvas. Pure; the values are capped by `v` like the rest of the overview.

import { ancestry } from '../../shared/opora-scope.js';
import { layerCounts, layerTree, type OporaLayersReply } from '../../shared/opora-layers.js';
import type { OporaScopeNode } from '../../shared/protocol.js';

export type PageRead = Omit<OporaLayersReply, 'linked' | 'base' | 'nodeId'>;

/** The card's way down from the top of the architecture, in words; '' when it isn't in it. */
export function cardPath(scope: readonly OporaScopeNode[], cardId: string): string {
  const by = new Map(scope.map((n) => [n.id, n]));
  return ancestry(scope, cardId).reverse().map((id) => by.get(id)!).map((n) => (n.host ? `${n.name} (${n.host})` : n.name)).join(' › ');
}

export function pageLines(path: string | undefined, page: PageRead | undefined, v: (s: unknown, n?: number) => string): string[] {
  const lines = [`Where (cell focus at the switchboard): ${path ? v(path, 240) : 'not in the architecture the switchboard shows'}`];
  if (!page) return [...lines, 'Page on Opora: not read yet'];
  if (page.state !== 'ok') return [...lines, `Page on Opora: ${page.state === 'missing' ? 'not on the canvas' : 'Opora not answering'}`];
  const s = page.settings;
  if (s) {
    const where = [s.route ? `route ${v(s.route, 80)}` : '', s.source ? `source ${v(s.source, 100)}` : ''].filter(Boolean).join(' · ');
    lines.push(`Page settings: ${[s.purpose ? `purpose: ${v(s.purpose, 200)}` : '', where].filter(Boolean).join(' · ') || 'none written'}`);
    const spec = [s.goal ? `goal: ${v(s.goal, 200)}` : '', s.nonGoals ? `non-goals: ${v(s.nonGoals, 140)}` : '', s.acceptance ? `acceptance: ${v(s.acceptance, 200)}` : ''].filter(Boolean);
    lines.push(`Page spec: ${spec.join(' · ') || 'empty (no goal, non-goals or acceptance yet)'}`);
    lines.push(`Page plan: ${s.working.length ? `${s.working.length} working steps (${s.working.slice(0, 5).map((t) => v(t, 50)).join('; ')})` : 'no working steps'} · ${s.accepted ? `${s.accepted.length} accepted` : 'none accepted'}`);
  }
  if (page.project) lines.push(`Project settings: ${Object.entries(page.project).slice(0, 6).map(([k, x]) => `${v(k, 20)} ${v(x, 60)}`).join(' · ')}`);
  const c = layerCounts(page.layers);
  if (!page.layers.length) lines.push('Inside the page on the canvas: nothing yet. Lay it out by layers: areas → sectors → nodes (cards).');
  else {
    const tree = layerTree(page.layers, page.layers[0].parentId).slice(0, 4).map((a) => {
      const secs = a.sectors.slice(0, 3).map((s) => `${s.sector ? `sector "${v(s.sector.name, 40)}"` : 'loose'} (${s.nodes.length} nodes${s.nodes.length ? `: ${s.nodes.slice(0, 3).map((n) => v(n.name, 40)).join('; ')}` : ''})`);
      return `${a.area ? `area "${v(a.area.name, 50)}"` : 'outside areas'}: ${secs.join(', ') || 'empty'}`;
    });
    lines.push(`Inside the page on the canvas: ${c.area} areas, ${c.sector} sectors, ${c.node} nodes. ${tree.join(' | ')}`);
  }
  lines.push('Plan inside this path only: new areas, sectors, nodes and tasks go into this page on the canvas.');
  return lines;
}
