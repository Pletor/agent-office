import type { CanvasNode } from '../../shared/opora-scope.js';
import { record } from './source.js';

export interface WorkRow {
  id: string;
  name: string;
  status: string;
  waitingOnHuman: { id: string; ask: string }[];
}

export function workRows(value: unknown): WorkRow[] {
  const nodes = record(record(value)?.nodes);
  if (!nodes) throw new Error('Opora vrátila neplatný přehled práce');
  return Object.entries(nodes).map(([key, value]) => {
    const row = record(value);
    if (!row || row.id !== key || typeof row.name !== 'string' || typeof row.status !== 'string' ||
      !Array.isArray(row.waitingOnHuman)) throw new Error('Opora vrátila neplatnou položku práce');
    const asks = row.waitingOnHuman.map((value, index) => {
      const ask = record(value);
      if (!ask || typeof ask.ask !== 'string') throw new Error('Opora vrátila neplatnou otázku pro člověka');
      return { id: String(ask.blockId ?? ask.stageId ?? index), ask: ask.ask.trim() };
    }).filter((ask) => ask.ask);
    return { id: key, name: row.name, status: row.status, waitingOnHuman: asks };
  });
}

/** Missing pipeline evidence cannot become a completion approval. Retries follow Opora's roots. */
export function pipelineState(value: unknown): 'complete' | 'incomplete' | 'unknown' {
  const pipeline = record(record(value)?.pipeline);
  if (!pipeline || !Array.isArray(pipeline.stages) || !pipeline.stages.length ||
    !Array.isArray(pipeline.stuck) || !('current' in pipeline)) return 'unknown';
  const stages = pipeline.stages.map(record);
  if (stages.some((s) => !s || typeof s.id !== 'string' ||
    !['todo', 'doing', 'passed', 'failed', 'skipped'].includes(String(s.status)))) return 'unknown';
  if (pipeline.current !== null || pipeline.stuck.length) return 'incomplete';
  const byId = new Map(stages.map((s) => [s!.id, s!]));
  const root = (stage: Record<string, unknown>): unknown => {
    const seen = new Set<unknown>();
    while (stage.retryOf) {
      if (seen.has(stage.id)) return undefined;
      seen.add(stage.id);
      const parent = byId.get(stage.retryOf);
      if (!parent) return undefined;
      stage = parent;
    }
    return stage.id;
  };
  if (stages.some((s) => root(s!) === undefined)) return 'unknown';
  return stages.every((s) => s!.status === 'passed' || s!.status === 'skipped' ||
    (s!.status === 'failed' && stages.some((later) => later!.status === 'passed' && root(later!) === root(s!))))
    ? 'complete' : 'incomplete';
}

export function ancestry(nodeId: string, nodes: Map<string, CanvasNode>): { path: string[]; parent: string; error?: string } {
  const node = nodes.get(nodeId);
  if (!node) return { path: [], parent: '', error: 'Úkol chybí v aktuálním plátně' };
  const path: string[] = [];
  const seen = new Set([nodeId]);
  let id = node.parentId;
  while (id) {
    if (seen.has(id)) return { path, parent: node.parentId ?? '', error: 'Nadřazené uzly plátna tvoří cyklus' };
    seen.add(id);
    const parent = nodes.get(id);
    if (!parent) return { path, parent: node.parentId ?? '', error: 'Cesta k nadřazeným uzlům plátna není úplná' };
    path.unshift(parent.name);
    id = parent.parentId;
  }
  return { path, parent: node.parentId ?? '' };
}

export function taskUrl(base: string, project: string, workspace: string, parent: string, nodeId: string): string {
  const url = new URL('/', base);
  url.search = new URLSearchParams({ project, workspace, screen: 'canvas', environment: 'editor', mode: 'structure', layer: parent, node: nodeId }).toString();
  return url.toString();
}
