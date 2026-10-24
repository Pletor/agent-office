import { readFileSync } from 'node:fs';

/** Explicit versioned hierarchy protocol; legacy --assign stays compatible with custom tasks. */
export function hierarchyCommand(action, args, task, url) {
  const levels = ['global', 'repository', 'page', 'layer', 'area', 'sector', 'task'];
  url.searchParams.set('hierarchy', '1');
  if (task) url.searchParams.set('node', task);
  if (['--hierarchy', '--origin-history'].includes(action) && args.length <= 1 && (!args.length || levels.includes(args[0]))) {
    if (action === '--origin-history') url.searchParams.set('origin-history', '1');
    if (args[0]) url.searchParams.set('scope', args[0]);
    return undefined;
  }
  if (action === '--bind' && (args.length === 3 || args.length === 4 && args[3] === '--rebind')) {
    const revision = Number(args[2]);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Binding revision must be a nonnegative integer from --hierarchy.');
    return JSON.stringify({ op: 'bind', project: args[0], workspace: args[1], revision, rebind: args[3] === '--rebind' });
  }
  if (action === '--configure' && args.length === 2 && levels.includes(args[0])) {
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    return JSON.stringify({ op: 'save', scope: args[0], revision: data.revision, layer: data.layer, pathDigest: data.pathDigest });
  }
  throw new Error('Usage: --hierarchy [LEVEL] [--task KEY] | --configure LEVEL file.json [--task KEY] | --bind PROJECT WORKSPACE REVISION [--rebind]');
}
