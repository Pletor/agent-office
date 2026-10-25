import type { Floor } from '../floor.js';
import { parseOriginHistory } from '../../shared/harness-origin-history.js';
import type { HarnessLevel } from '../../shared/harness-cascade.js';
import { hierarchyAbout, oporaOrigin } from './hierarchy-context.js';
import { HarnessError } from './profiles.js';

/** Fixed configured peer; no worker/session/execution credentials leave Office. */
export async function originHistory(dataDir: string, floor: Floor, level: HarnessLevel, target: string, read: typeof fetch = fetch) {
  const before = hierarchyAbout(dataDir, floor);
  if (before.notice || !before.binding) throw new HarnessError('Historie vyžaduje dostupné připojení k Opoře.', 503);
  const identity = (value: ReturnType<typeof hierarchyAbout>) => JSON.stringify([
    value.public.bindingRevision, value.binding, value.linked, value.view.connected, oporaOrigin(value.view.url), value.notice]);
  const original = identity(before), url = new URL('/api/oporahub/harness-origin-history', before.view.url);
  url.searchParams.set('project', before.binding.project); url.searchParams.set('workspace', before.binding.workspace);
  url.searchParams.set('originScope', level); if (target) url.searchParams.set('originNode', target);
  try {
    const response = await read(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!response.ok || !response.body || response.redirected) throw new Error('unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; if (size > 256 * 1024) throw new Error('oversized'); chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const report = parseOriginHistory(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), before.binding.project, before.binding.workspace);
    if (report.cohorts.some(c => c.origin.scope !== level || c.origin.node !== (target || null))) throw new Error('foreign origin');
    if (identity(hierarchyAbout(dataDir, floor)) !== original) throw new Error('binding changed');
    return report;
  } catch { throw new HarnessError('Historie původu není dostupná nebo neodpovídá vybranému projektu a původu.', 503); }
}
