import type { HierarchyNode } from './harness-hierarchy.js';

export interface GeometryNode extends HierarchyNode { x: number; y: number; size?: { w: number; h: number } }
export const AREA_MEMBERSHIP_CONTRACT = 'canvas.explicit-memberOf/1';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Comments do not create parents or make a leaf card change its Harness level. */
export function parseHarnessCanvas(value: unknown): HierarchyNode[] {
  if (!object(value) || !object(value.graph) || !Array.isArray(value.graph.nodes) || value.graph.nodes.length > 5000) throw new Error('Unsupported or oversized Canvas hierarchy.');
  const nodes: GeometryNode[] = [], ids = new Set<string>();
  for (const row of value.graph.nodes) {
    if (!object(row) || !id(row.id) || ids.has(row.id)) throw new Error('Invalid or duplicate Canvas node ID.');
    ids.add(row.id);
    if (row.kind === 'comment') {
      if ('memberOf' in row) throw new Error('Comments cannot carry Canvas membership.');
      continue;
    }
    if ('memberOf' in row && (!id(row.memberOf) || row.kind === 'area')) throw new Error('Invalid explicit Canvas membership.');
    if (!['node', 'sector', 'area'].includes(row.kind as string) || typeof row.name !== 'string' || row.name.length > 500
      || !(row.parentId === null || id(row.parentId)) || !finite(row.x) || !finite(row.y)) throw new Error('Invalid Canvas hierarchy node.');
    let size: GeometryNode['size'];
    if (row.size !== undefined && row.size !== null) {
      if (!object(row.size) || !finite(row.size.w) || !finite(row.size.h) || row.size.w <= 0 || row.size.h <= 0) throw new Error('Invalid Canvas area size.');
      size = { w: row.size.w, h: row.size.h };
    }
    nodes.push({ id: row.id, kind: row.kind as GeometryNode['kind'], name: row.name, parentId: row.parentId as string | null, x: row.x, y: row.y, ...(size ? { size } : {}), ...('memberOf' in row ? { memberOf: row.memberOf as string } : {}) });
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const node of nodes) {
    if (node.memberOf) {
      const area = byId.get(node.memberOf);
      if (!area || area.kind !== 'area' || area.parentId !== node.parentId) throw new Error('Invalid explicit Canvas area reference.');
    }
    const seen = new Set<string>();
    for (let at: GeometryNode | undefined = node; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
      if (seen.has(at.id) || seen.size >= 64) throw new Error('Cyclic or excessively deep Canvas hierarchy.');
      seen.add(at.id);
      if (at.parentId && (!byId.has(at.parentId) || byId.get(at.parentId)?.kind === 'area')) throw new Error('Invalid Canvas hierarchy parent.');
    }
  }
  return nodes.map(({ id, kind, name, parentId, memberOf }) =>
    ({ id, kind, name, parentId, ...(memberOf ? { memberOf } : {}) }));
}
