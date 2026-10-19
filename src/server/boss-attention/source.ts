import type { CanvasNode } from '../../shared/opora-scope.js';

export interface AttentionSource {
  overview(): Promise<unknown>;
  nodes(): Promise<CanvasNode[]>;
  brief(nodeId: string): Promise<unknown>;
}

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Fixed read endpoints only; base and scope come from the floor, never request parameters. */
export function attentionSource(base: string, project: string, workspace: string, signal?: AbortSignal): AttentionSource {
  async function get(path: string, nodeId?: string): Promise<unknown> {
    const url = new URL(path, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Neplatná adresa Opory');
    url.search = new URLSearchParams({ project, workspace, ...(nodeId ? { nodeId } : {}) }).toString();
    const response = await fetch(url, {
      method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'X-Opora-Actor': 'agent; name=office-attention' },
    }).catch(() => { throw new Error(signal?.aborted ? 'Vypršel čas pro načtení přehledu' : 'Opora neodpovídá nebo vypršel čas pro načtení'); });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Načtení z Opory selhalo (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error('Opora nevrátila žádná data');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4 * 1024 * 1024) throw new Error('Odpověď Opory překročila limit velikosti přehledu');
        chunks.push(next.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('Opora vrátila neplatný formát JSON'); }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return {
    overview: () => get('/api/desktop-v3/work-overview'),
    brief: (id) => get('/api/desktop-v3/node-brief', id),
    async nodes() {
      const data = record(await get('/api/view'));
      const nodes = record(data?.graph)?.nodes;
      if (!Array.isArray(nodes)) throw new Error('Opora vrátila neplatná data plátna');
      return nodes.map((value): CanvasNode => {
        const n = record(value);
        if (!n || typeof n.id !== 'string' || typeof n.name !== 'string' ||
          !(n.parentId === null || typeof n.parentId === 'string')) throw new Error('Opora vrátila neplatný uzel plátna');
        return { id: n.id, name: n.name, parentId: n.parentId, kind: String(n.kind ?? '') };
      });
    },
  };
}
