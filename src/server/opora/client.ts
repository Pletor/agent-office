// Talking to Opora Canvas over its HTTP API, from the office's server (never the browser: Opora takes
// writes only from its own origin, which a server can say it is and a page from the office can't).

import type { CanvasNode } from '../../shared/opora-scope.js';
import { digestAgentState, type AgentStateDigest } from './agent-state.js';

/** What Opora said when a call didn't go through: its HTTP status (0 when it didn't answer) and its words. */
export class OporaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Lease {
  token: string;
  expiresAt?: string;
}

const TIMEOUT_MS = 8000;

/**
 * Opora's API: the reads the bridge polls, and the card's lease. Every call names the office as an
 * agent (X-Opora-Actor), and writes say they come from Opora's own origin and carry JSON, as Opora
 * checks for every write that doesn't come from its page.
 */
export class OporaClient {
  readonly origin: string;

  constructor(
    readonly base: string,
    private agent = 'office',
  ) {
    this.origin = new URL(base).origin;
  }

  health(): Promise<{ status?: string; product?: string }> {
    return this.get('/api/health');
  }

  /** What Opora started from (its commit, and hashes of its sources and its page); a 404 on an Opora without it. */
  buildIdentity(): Promise<{ commit?: unknown }> {
    return this.get('/api/build-identity');
  }

  /**
   * The framing headers of Opora's page (GET /): X-Frame-Options and Content-Security-Policy, which
   * say whether a browser lets the office show it in a frame. Only the headers are read.
   */
  async frameHeaders(): Promise<{ xFrameOptions: string | null; csp: string | null }> {
    let res: Response;
    try {
      res = await fetch(new URL('/', this.base), { method: 'GET', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new OporaError(0, `Opora isn't answering at ${this.base} (${(err as Error).message})`);
    }
    void res.body?.cancel().catch(() => undefined);
    return { xFrameOptions: res.headers.get('x-frame-options'), csp: res.headers.get('content-security-policy') };
  }

  /** Opora's projects, each with the folder it plans. */
  async projects(): Promise<{ id: string; name: string; sourcePath?: string | null }[]> {
    const b = await this.get<{ projects?: unknown }>('/api/bootstrap');
    const rows = Array.isArray(b.projects) ? (b.projects as Record<string, unknown>[]) : [];
    return rows
      .filter((p) => p && typeof p.id === 'string' && p.id)
      .map((p) => ({ id: p.id as string, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 120) : (p.id as string), sourcePath: typeof p.sourcePath === 'string' ? p.sourcePath : null }));
  }

  /** A project's workspaces: `main` (read-only for a git project) and the work ones the planning happens in, each with Opora's label. */
  async workspaces(project: string): Promise<{ id: string; label: string }[]> {
    const w = await this.get<{ workspaces?: unknown }>('/api/project-workspaces', { project });
    const rows = Array.isArray(w.workspaces) ? (w.workspaces as Record<string, unknown>[]) : [];
    return rows
      .filter((x) => x && typeof x.id === 'string' && x.id)
      .map((x) => ({ id: x.id as string, label: typeof x.label === 'string' && x.label.trim() ? x.label.trim().slice(0, 160) : (x.id as string) }));
  }

  /** The canvas: every area, sector and card, with what each sits in, and a sector's site's environment and host. */
  async nodes(project: string, workspace: string): Promise<CanvasNode[]> {
    const v = await this.get<{ graph?: { nodes?: unknown } }>('/api/view', { project, workspace });
    const nodes = Array.isArray(v.graph?.nodes) ? (v.graph!.nodes as Record<string, unknown>[]) : [];
    return nodes
      .map((n) => {
        const site = n.site && typeof n.site === 'object' ? (n.site as { environments?: unknown; kind?: unknown }) : undefined;
        const env = Array.isArray(site?.environments) ? (site.environments[0] as { name?: unknown; host?: unknown } | undefined) : undefined;
        return {
          id: String(n.id ?? ''),
          kind: String(n.kind ?? ''),
          name: String(n.name ?? '').slice(0, 120),
          parentId: typeof n.parentId === 'string' ? n.parentId : null,
          ...(typeof env?.name === 'string' && env.name.trim() ? { env: env.name.trim().slice(0, 60) } : {}),
          ...(typeof env?.host === 'string' && env.host.trim() ? { host: env.host.trim().slice(0, 120) } : {}),
          ...(site?.kind === 'page' ? { page: true } : {}),
        };
      })
      .filter((n) => n.id);
  }

  /** What agents did on the canvas lately, newest first (Opora logs every write to its API). */
  async activity(project: string, workspace: string, limit: number): Promise<{ id: number; at: string; agent: string; method: string; path: string; nodeIds: string[]; status: number }[]> {
    const a = await this.get<{ entries?: unknown }>('/api/activity-log', { project, workspace, actor: 'agent', limit: String(limit) });
    const rows = Array.isArray(a.entries) ? (a.entries as Record<string, unknown>[]) : [];
    return rows
      .filter((e) => e && typeof e.id === 'number')
      .map((e) => ({
        id: e.id as number,
        at: typeof e.at === 'string' ? e.at : '',
        agent: typeof e.agent === 'string' ? e.agent.slice(0, 80) : 'agent',
        method: typeof e.method === 'string' ? e.method : '',
        path: typeof e.path === 'string' ? e.path : '',
        nodeIds: Array.isArray(e.nodeIds) ? e.nodeIds.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
        status: typeof e.status === 'number' ? e.status : 0,
      }));
  }

  /** What's on turn: the root of the canvas, or inside one sector. */
  frontier(project: string, workspace: string, nodeId?: string): Promise<unknown> {
    return this.get('/api/desktop-v3/frontier', { project, workspace, ...(nodeId ? { nodeId } : {}) });
  }

  /**
   * One read of Canvas's agent-state: the cards it offers a ready `claim` for (accepted plan steps,
   * budget, no unfinished predecessor), and what waits on a person (agent-state.ts). Throws on a
   * Canvas without agent-state.
   */
  async agentState(project: string, workspace: string): Promise<AgentStateDigest> {
    return digestAgentState(await this.get<unknown>('/api/oporahub/agent-state', { project, workspace }));
  }

  /**
   * Whether the project is planned by OPORA's heart: its brain gate is on (GET /api/brain/gate-setting).
   * An Opora without the brain answers 404, which is off.
   */
  async heartOn(project: string): Promise<boolean> {
    try {
      const g = await this.get<{ enabled?: unknown }>('/api/brain/gate-setting', { project });
      return g.enabled === true;
    } catch (err) {
      if (err instanceof OporaError && err.status === 404) return false;
      throw err;
    }
  }

  /** One drawing layer's Excalidraw scene: a card's or sector's own (its id), or a storyboard moment's (`sb/<card>/<moment>`). */
  async drawing(project: string, workspace: string, layer: string): Promise<{ elements: Record<string, unknown>[] }> {
    const d = await this.get<{ scene?: { elements?: unknown } }>('/api/drawing', { project, workspace, layer });
    const elements = Array.isArray(d.scene?.elements) ? (d.scene!.elements as Record<string, unknown>[]) : [];
    return { elements: elements.filter((e) => e && typeof e === 'object' && !e.isDeleted) };
  }

  /** A card's storyboard, or null when it has none. */
  async storyboard(project: string, workspace: string, nodeId: string): Promise<Record<string, unknown> | null> {
    const s = await this.get<{ storyboard?: unknown }>('/api/storyboard', { project, workspace, nodeId });
    return s.storyboard && typeof s.storyboard === 'object' ? (s.storyboard as Record<string, unknown>) : null;
  }

  /** One card of the canvas as Opora keeps it (its `design`, `blocks`, `materials`…), or undefined when it isn't there. */
  async rawNode(project: string, workspace: string, nodeId: string): Promise<Record<string, unknown> | undefined> {
    const v = await this.get<{ graph?: { nodes?: unknown } }>('/api/view', { project, workspace });
    const nodes = Array.isArray(v.graph?.nodes) ? (v.graph!.nodes as Record<string, unknown>[]) : [];
    return nodes.find((n) => n && n.id === nodeId);
  }

  /** The project's design system (its DESIGN.md), from an Opora that has the endpoint; a 404 on one without. */
  designSystem(project: string): Promise<unknown> {
    return this.get('/api/oporahub/design-system', { project });
  }

  /** A design card's preview record (its `design.mode`, DESIGN.md reference, screenshots per head); a 404 on an Opora without it. */
  reviewPreview(project: string, workspace: string, nodeId: string): Promise<unknown> {
    return this.get('/api/oporahub/review-preview', { project, workspace, nodeId });
  }

  async claim(project: string, workspace: string, nodeId: string, owner: string, ttlSeconds: number): Promise<Lease> {
    const r = await this.post<{ token?: unknown; expiresAt?: unknown }>('/api/desktop-v3/lease', { project, workspace, nodeId, op: 'claim', owner, ttlSeconds });
    if (typeof r.token !== 'string' || !r.token) throw new OporaError(0, 'Opora gave no lease token');
    return { token: r.token, ...(typeof r.expiresAt === 'string' ? { expiresAt: r.expiresAt } : {}) };
  }

  async heartbeat(project: string, workspace: string, nodeId: string, token: string, ttlSeconds: number): Promise<Lease> {
    const r = await this.post<{ expiresAt?: unknown }>('/api/desktop-v3/lease', { project, workspace, nodeId, op: 'heartbeat', token, ttlSeconds });
    return { token, ...(typeof r.expiresAt === 'string' ? { expiresAt: r.expiresAt } : {}) };
  }

  async release(project: string, workspace: string, nodeId: string, token: string): Promise<void> {
    await this.post('/api/desktop-v3/lease', { project, workspace, nodeId, op: 'release', token });
  }

  /** The office's live process events, for Opora's Hub (see server/process/push.ts); a 404 on an Opora without it. */
  async processEvents(events: unknown[]): Promise<{ accepted?: number; duplicates?: number; rejected?: { index?: number; id?: string; error?: string }[] }> {
    return this.post('/api/oporahub/process-events', { events });
  }

  /** The plan's accepted head, graph digest and every card's live and accepted specification (docs/oporahub-*.md in Canvas). */
  changesetContext(project: string, workspace: string): Promise<{ acceptedHead?: unknown; graphDigest?: unknown; readOnly?: unknown;
    documents?: { nodeId: string; revision: number; fields: Record<string, unknown> }[]; acceptedDocuments?: { nodeId: string }[] }> {
    return this.get('/api/oporahub/changesets/context', { project, workspace });
  }

  /** A proposed specification change; only a person accepts it in Opora. */
  proposeChangeset(body: unknown): Promise<{ id?: unknown; accepted?: unknown }> {
    return this.post('/api/oporahub/changesets', body);
  }

  private get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return this.call<T>(url, { method: 'GET' });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(new URL(path, this.base), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: this.origin } });
  }

  private async call<T>(url: URL, init: { method: string; body?: string; headers?: Record<string, string> }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { Accept: 'application/json', 'X-Opora-Actor': `agent; name=${this.agent}`, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new OporaError(0, `Opora isn't answering at ${this.base} (${(err as Error).message})`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : text.slice(0, 200);
      throw new OporaError(res.status, `Opora said ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    if (data === undefined) throw new OporaError(res.status, 'Opora answered with something that isn’t JSON');
    return data as T;
  }
}
