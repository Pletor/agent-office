// Reads what's inside one page of the project on Opora's canvas, for the purple board's "Canvas živě"
// (GET /api/opora-layers) and the orchestrator's overview: the canvas (`GET /api/view`), the page's
// spec and plan steps (`GET /api/node-spec`) and the project's settings (`GET /api/project-settings`).
// Read-only GETs with the office's usual X-Opora-Actor, no lease token and no write. Each answer is
// kept 30 s, so a board redrawn every second doesn't ask again; a refusal or a timeout is an answer too.

import { pageSettings, parseLayers, projectSettings, type OporaLayersReply } from '../../shared/opora-layers.js';
import { str } from '../../shared/opora-lens.js';

const TTL_MS = 30_000;
const TIMEOUT_MS = 5000;
/** The whole canvas comes in one answer: big projects have big ones. */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 100;

type Fetch = typeof fetch;
type Read = { status: number; data?: unknown };

export interface LayersTarget { base: string; agent: string; project: string; workspace: string }

export class LayersReader {
  private cache = new Map<string, { at: number; value: Promise<Read> }>();

  constructor(private fetcher: Fetch = fetch, private now: () => number = Date.now) {}

  /** The page `nodeId`: its settings and the areas, sectors and nodes inside it. */
  async page(t: LayersTarget, nodeId: string): Promise<Omit<OporaLayersReply, 'linked' | 'base' | 'nodeId'>> {
    const [view, spec, project] = await Promise.all([
      this.read(t, '/api/view', { project: t.project, workspace: t.workspace }),
      this.read(t, '/api/node-spec', { project: t.project, workspace: t.workspace, node: nodeId }),
      this.read(t, '/api/project-settings', { project: t.project }),
    ]);
    if (view.status !== 200) return { state: 'unavailable', layers: [] };
    const { node, layers } = parseLayers(view.data, nodeId);
    if (!node) return { state: 'missing', layers: [] };
    const settings = pageSettings(node, spec.status === 200 ? spec.data : undefined);
    const proj = project.status === 200 ? projectSettings(project.data) : undefined;
    return { state: 'ok', name: str(node.name, 120), settings, ...(proj ? { project: proj } : {}), layers };
  }

  private read(t: LayersTarget, path: string, query: Record<string, string>): Promise<Read> {
    const url = new URL(path, t.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const key = `${t.agent} ${url.href}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    for (const [k, v] of this.cache) if (now - v.at >= TTL_MS) this.cache.delete(k);
    while (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    const value = this.get(url, t.agent);
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async get(url: URL, agent: string): Promise<Read> {
    try {
      const res = await this.fetcher(url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json', 'X-Opora-Actor': `agent; name=${agent}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { void res.body?.cancel().catch(() => undefined); return { status: res.status }; }
      const text = await res.text();
      if (text.length > MAX_BYTES) return { status: 413 };
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: 0 };
    }
  }
}

export const layersReader = new LayersReader();
