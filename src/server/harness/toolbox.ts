import type { HarnessEntry } from '../../shared/harness.js';
import type { HarnessLibrary } from './catalog.js';

export interface ToolDescriptor { path: string; problems: string[]; requires: string[]; priority: number; publication?: string }
export const toolId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/.test(value);
export function parseToolbox(value: any): ToolDescriptor[] {
  if (!value || Object.keys(value).sort().join(',') !== 'resources,schema' || !['harness.toolbox/1', 'harness.toolbox/2'].includes(value.schema)
    || !Array.isArray(value.resources) || value.resources.length > 64) throw new Error('Invalid Harness toolbox descriptor');
  const paths = new Set<string>(), shared = value.schema === 'harness.toolbox/2';
  return value.resources.map((item: any) => {
    if (!item || Object.keys(item).sort().join(',') !== (shared ? 'path,priority,problems,publication,requires' : 'path,priority,problems,requires')
      || (shared && (!toolId(item.publication) || /[\x00-\x1f\x7f]/.test(item.publication)))
      || typeof item.path !== 'string' || item.path.length > 240 || /[\\\x00-\x1f\x7f]/.test(item.path)
      || item.path.split('/').some((part: string) => !part || part === '.' || part === '..') || paths.has(item.path)
      || !Array.isArray(item.problems) || item.problems.length < 1 || item.problems.length > 8 || !item.problems.every(toolId) || new Set(item.problems).size !== item.problems.length
      || !Array.isArray(item.requires) || item.requires.length > 16 || !item.requires.every(toolId) || new Set(item.requires).size !== item.requires.length
      || !Number.isSafeInteger(item.priority) || Math.abs(item.priority) > 100) throw new Error('Invalid tool descriptor');
    paths.add(item.path); return { path: item.path, problems: [...item.problems], requires: [...item.requires], priority: item.priority, ...(shared ? { publication: item.publication } : {}) };
  });
}
/** Only intentionally published project/shared manifests can opt resources into automatic selection. */
export async function toolbox(library: HarnessLibrary, entries: HarnessEntry[], problem: string) {
  const result = new Map<string, ToolDescriptor>();
  const snapshots: { id: string; text: string }[] = [];
  for (const source of ['Project / .harness', 'Shared harness']) {
    const manifest = entries.find(entry => entry.source === source && entry.path === 'toolbox.json');
    if (!manifest) continue;
    const text = await library.read(manifest.id);
    if (!text) throw new Error('Toolbox changed or is unreadable; reload before preparing a kit');
    snapshots.push({ id: manifest.id, text: text.text });
    for (const descriptor of parseToolbox(JSON.parse(text.text))) {
      if (descriptor.publication && source !== 'Shared harness') throw new Error('Publication references require an intentionally shared Harness source');
      if (!descriptor.problems.includes(problem)) continue;
      const entry = entries.find(entry => entry.source === source && entry.path === descriptor.path);
      if (!entry) throw new Error('Declared tool is unavailable in its published source: ' + descriptor.path);
      if (descriptor.path === 'toolbox.json') throw new Error('A toolbox cannot select itself');
      result.set(entry.id, descriptor);
    }
  }
  if (new Set([...result.values()].flatMap(item => item.publication ? [item.publication] : [])).size > 8) throw new Error('More than eight shared publications; narrow the toolbox');
  if (result.size > 64) throw new Error('More than 64 matching tool candidates; narrow the toolbox');
  return { descriptors: result, async verify() {
    for (const snapshot of snapshots) if ((await library.read(snapshot.id))?.text !== snapshot.text) throw new Error('Toolbox changed during preparation. Retry.');
  } };
}
