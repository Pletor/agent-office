import { parseHarnessCanvas } from '../../shared/harness-canvas.js';
import type { OporaPlace } from '../../shared/opora-identity.js';
import { HarnessError } from './profiles.js';

/** Server-configured origin only, with the same project/workspace the floor is bound to. */
export async function harnessCanvas(base: string, place: OporaPlace, read: typeof fetch = fetch) {
  let url: URL;
  try {
    url = new URL('/api/view', base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
  } catch { throw new HarnessError('Invalid configured Opora URL.', 503); }
  url.searchParams.set('project', place.project); url.searchParams.set('workspace', place.workspace);
  try {
    const response = await read(url, { headers: { accept: 'application/json', 'X-Opora-Actor': 'agent; name=office-harness' },
      redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('Canvas hierarchy exceeds 8 MiB');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return parseHarnessCanvas(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  } catch (err) { throw new HarnessError('Canvas hierarchy unavailable: ' + (err as Error).message, 503); }
}
