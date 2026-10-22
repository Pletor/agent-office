// Opora's side of the work as it happens: one SSE connection per floor to Canvas's event outbox
// (GET /api/oporahub/events/stream?project&workspace), each event mapped (opora-outbox.ts) into the
// floor's process journal at once, instead of waiting for the bridge's 20 s card poll.
//
// It starts from the outbox's head (no replay of history), resumes with Last-Event-ID, reopens a
// little before Canvas's per-connection limit (~300 s), drops a connection that stays silent past
// a few heartbeats, and backs off 1 s → 30 s while Opora doesn't answer. Nothing is persisted: the
// cursor lives in memory. It never throws into the office.

import type { ProcessStreamHealth } from '../../shared/protocol.js';
import type { ProcessHub } from './hub.js';
import { outboxToProcess, type OutboxEvent } from './opora-outbox.js';

export const STREAM_REOPEN_MS = 280_000;
/** Canvas sends `: heartbeat` every 15 s: this long without a byte is a dead connection. */
export const STREAM_SILENT_MS = 45_000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export interface StreamWhere {
  base: string;
  project: string;
  workspace: string;
}

export interface StreamOptions extends StreamWhere {
  /** The Opora agent name the office calls as (X-Opora-Actor, as OporaClient does). */
  agent: string;
  /** Where to resume from (an outbox id); without it the stream starts at the outbox's head. */
  cursor?: string;
  onEvent(e: OutboxEvent): void;
  onHealth(h: ProcessStreamHealth): void;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  reopenMs?: number;
  silentMs?: number;
  backoffMs?: readonly number[];
}

/** One live connection to Opora's event stream, reconnecting until stopped. */
export class OporaStream {
  cursor?: string;
  connected = false;
  lastEventAt?: number;
  /** How many connections were opened (for tests and diagnostics). */
  opened = 0;
  private stopped = false;
  private abort?: AbortController;
  private wake?: () => void;
  private gapLogged = false;
  private failures = 0;
  private readonly fetch: typeof fetch;

  constructor(private o: StreamOptions) {
    this.cursor = o.cursor;
    this.fetch = o.fetch ?? fetch;
  }

  start() {
    void this.run().catch(() => undefined);
    return this;
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
  }

  get health(): ProcessStreamHealth {
    return { connected: this.connected, ...(this.lastEventAt ? { lastEventAt: new Date(this.lastEventAt).toISOString() } : {}) };
  }

  private headers(accept: string): Record<string, string> {
    return { Accept: accept, 'X-Opora-Actor': `agent; name=${this.o.agent}`, ...(this.cursor ? { 'Last-Event-ID': this.cursor } : {}) };
  }

  private url(path: string, extra: Record<string, string> = {}): URL {
    const url = new URL(path, this.o.base);
    for (const [k, v] of Object.entries({ project: this.o.project, workspace: this.o.workspace, ...extra })) url.searchParams.set(k, v);
    return url;
  }

  private setConnected(on: boolean) {
    if (this.connected === on) return;
    this.connected = on;
    try {
      this.o.onHealth(this.health);
    } catch {
      /* the listener's own trouble */
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  /** The outbox's newest id, so a new stream follows from now on instead of replaying history. */
  private async head(): Promise<string> {
    const res = await this.fetch(this.url('/api/oporahub/events', { limit: '1', since: '0' }), { headers: this.headers('application/json'), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Opora said ${res.status}`);
    const body = (await res.json()) as { head?: unknown };
    return String(typeof body.head === 'number' && body.head >= 0 ? body.head : 0);
  }

  private async run() {
    while (!this.stopped) {
      let clean = false;
      try {
        this.cursor ??= await this.head();
        clean = await this.connect();
      } catch {
        if (this.stopped) break;
        this.setConnected(false);
      }
      if (this.stopped) break;
      // A planned close (Canvas's time limit, or ours just before it) reconnects at once and stays "connected".
      if (clean) continue;
      const backoff = this.o.backoffMs ?? BACKOFF_MS;
      await this.sleep(backoff[Math.min(this.failures++, backoff.length - 1)]);
    }
    this.setConnected(false);
  }

  /** One connection: resolves true when it ended as planned, throws when it broke. */
  private async connect(): Promise<boolean> {
    const abort = new AbortController();
    this.abort = abort;
    let planned = false;
    const reopen = setTimeout(() => {
      planned = true;
      abort.abort();
    }, this.o.reopenMs ?? STREAM_REOPEN_MS);
    reopen.unref?.();
    let silent: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(silent);
      silent = setTimeout(() => abort.abort(), this.o.silentMs ?? STREAM_SILENT_MS);
      silent.unref?.();
    };
    try {
      const res = await this.fetch(this.url('/api/oporahub/events/stream', this.cursor ? { since: this.cursor } : {}), { headers: this.headers('text/event-stream'), signal: abort.signal });
      if (!res.ok || !res.body) {
        void res.body?.cancel().catch(() => undefined);
        throw new Error(`Opora said ${res.status}`);
      }
      this.opened++;
      this.failures = 0;
      this.setConnected(true);
      alive();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return true;
        alive();
        buf += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + (buf[at] === '\r' ? 4 : 2));
          this.frame(frame);
        }
      }
    } catch (err) {
      if (planned || this.stopped) return true;
      throw err;
    } finally {
      clearTimeout(reopen);
      clearTimeout(silent);
    }
  }

  /** One SSE frame: `id:` + `data:` is an event; comments (heartbeats) and `retry:` only keep it alive. */
  private frame(frame: string) {
    let id: string | undefined, type = 'message';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
      else if (field === 'event') type = value;
    }
    if (!data.length) return;
    let event: (OutboxEvent & { gap?: unknown }) | undefined;
    try {
      event = JSON.parse(data.join('\n'));
    } catch {
      event = undefined;
    }
    if (type === 'gap' || (event && event.gap === true && !event.kind)) {
      // Retention dropped events we never saw: carry on from here, say it once.
      if (!this.gapLogged) this.o.log?.(`agent-office: Opora's event stream for ${this.o.project}/${this.o.workspace} skipped events (retention gap); following on`);
      this.gapLogged = true;
    } else if (event && typeof event === 'object') {
      this.lastEventAt = Date.now();
      try {
        this.o.onEvent(event);
      } catch {
        /* never into the stream */
      }
    }
    if (id && /^\d+$/.test(id)) this.cursor = id;
  }
}

/** What a floor's Opora link says now (OporaState), as far as the stream cares. */
export interface StreamLink {
  url?: string;
  project?: { id: string } | null;
  workspace?: string | null;
}

/** One stream per floor bound to an Opora project and workspace; the hub hears its events and health. */
export class OporaStreams {
  private streams = new Map<string, { key: string; stream: OporaStream }>();
  /** The last cursor of each project/workspace a floor followed, so relinking resumes rather than skips. */
  private cursors = new Map<string, string>();

  constructor(
    private hub: ProcessHub,
    private health: (floorId: string, h: ProcessStreamHealth | undefined) => void,
    private make: (o: StreamOptions) => OporaStream = (o) => new OporaStream(o).start(),
    private log: (line: string) => void = (line) => console.log(line),
  ) {}

  /** The floor's link changed (or was re-sent): start, keep, replace or stop its stream. Never throws. */
  sync(floorId: string, link: StreamLink | undefined) {
    try {
      const where = link?.url && link.project?.id && link.workspace ? { base: link.url, project: link.project.id, workspace: link.workspace } : undefined;
      const key = where ? `${where.base}|${where.project}|${where.workspace}` : '';
      const had = this.streams.get(floorId);
      if (had?.key === key) return;
      if (had) this.stop(floorId);
      if (!where) return;
      // The callbacks below run only after the stream's first await, once `stream` is set.
      const stream: OporaStream = this.make({
        ...where,
        agent: `office-${floorId}`,
        cursor: this.cursors.get(`${floorId}|${key}`),
        log: this.log,
        onEvent: (e) => {
          // The snapshot's age of the stream moves with every event, echoes included (the floor isn't told each one).
          if (this.streams.get(floorId)?.key === key) this.hub.streams.set(floorId, stream.health);
          const input = outboxToProcess(e);
          if (input) this.hub.emit(floorId, input);
        },
        onHealth: (h) => {
          if (this.streams.get(floorId)?.key !== key) return;
          this.hub.streams.set(floorId, h);
          this.health(floorId, h);
        },
      });
      this.streams.set(floorId, { key, stream });
      this.hub.streams.set(floorId, stream.health);
      this.health(floorId, stream.health);
    } catch {
      /* never into the office */
    }
  }

  stop(floorId: string) {
    const had = this.streams.get(floorId);
    if (!had) return;
    this.streams.delete(floorId);
    if (had.stream.cursor) this.cursors.set(`${floorId}|${had.key}`, had.stream.cursor);
    had.stream.stop();
    this.hub.streams.delete(floorId);
    this.health(floorId, undefined);
  }

  /** Stops the streams of floors that are gone. */
  retain(keep: (floorId: string) => boolean) {
    for (const id of [...this.streams.keys()]) if (!keep(id)) this.stop(id);
  }

  stopAll() {
    for (const id of [...this.streams.keys()]) this.stop(id);
  }

  get size(): number {
    return this.streams.size;
  }
}
