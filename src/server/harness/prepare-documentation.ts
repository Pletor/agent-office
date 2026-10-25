/** Probe only the existing authenticated, accepted Context7 adapter; never a resource URL or command. */
import { createHash } from 'node:crypto';
import type { acceptedReceipt } from './invoke-node.js';

type Receipt = Awaited<ReturnType<typeof acceptedReceipt>>;
export type DocumentationProbe = (execution: Receipt['execution'], resource: { id: string; digest: string }) => Promise<boolean>;
const QUESTION = 'What API usage and version limitations does this library document?';

export function documentationProbe(base: string, worker: string, token: string, read: typeof fetch = fetch): DocumentationProbe {
  return async (execution, resource) => {
    if (!base || !worker || !token) return false;
    const url = new URL('/office/harness', base);
    url.searchParams.set('worker', worker); url.searchParams.set('docs', '1');
    const response = await read(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accepted-query', resource: resource.id, query: QUESTION }) });
    if (!response.ok || !response.body) { await response.body?.cancel(); return false; }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256 * 1024) return false;
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const accepted = value?.accepted;
    return value?.schema === 'harness.documentation/1' && value.authority === 'external-reference'
      && value.endpoint === 'https://mcp.context7.com/mcp' && value.tool === 'query-docs'
      && typeof value.text === 'string' && value.text.trim().length > 0
      && value.digest === createHash('sha256').update(value.text).digest('hex')
      && accepted?.adapter === 'context7-documentation/1' && accepted.authorityCurrentAtCompletion === true
      && accepted.resource?.id === resource.id && accepted.resource.digest === resource.digest
      && Object.entries(execution).every(([key, expected]) => accepted.execution?.[key] === expected);
  };
}
