import { HarnessError } from './profiles.js';

/** Fresh fixed-peer read; no credentials, redirect, cache or caller-selected endpoint. */
export async function requireKitV2(base: string, project: string, workspace: string, transport: typeof fetch = fetch) {
  try {
    const peer = new URL(base);
    if (!['http:', 'https:'].includes(peer.protocol) || peer.username || peer.password) throw new Error();
    const url = new URL('/api/oporahub/harness-kit-capabilities', peer.origin);
    url.search = new URLSearchParams({ project, workspace }).toString();
    const response = await transport(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > 8192) throw new Error(); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (value?.schema !== 'harness.kit-capabilities/1' || value.scope?.project !== project || value.scope?.workspace !== workspace
      || !Array.isArray(value.acceptedKitSchemas) || !value.acceptedKitSchemas.includes('harness.kit/2')
      || value.contextProtocolVersion !== 2 || value.selectionSchema !== 'harness.selection/1'
      || value.limits?.resources !== 24 || value.limits?.bytes !== 96 * 1024
      || value.evidence !== 'installed-acceptance-validator' || value.executionAdaptersVerified !== false
      || value.permissionsGranted !== false || value.promotionAllowed !== false) throw new Error();
  } catch { throw new HarnessError('Linked Opora has not established accepted kit v2 compatibility. Retry or update the peer.', 409); }
}
