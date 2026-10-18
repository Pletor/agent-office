import type { OporaActivity } from '../../shared/protocol.js';
import type { OporaClient } from './client.js';

/** How often the live canvas on the board reads what the agents did, and how much of it it keeps. */
const LIVE_MS = 5000;
const KEEP = 14;

/** What a write to Opora's API was, by the start of its path (the log keeps the path, not the body), in the board's Czech. */
const WORDS: [string, string][] = [
  ['desktop-v3/lease', 'si bere kartu'],
  ['desktop-v3/node', 'zapsal kartu'],
  ['desktop-v3/state', 'posunul kartu dál'],
  ['desktop-v3/pipeline', 'nasměroval kartu'],
  ['desktop-v3/agent-output', 'odevzdal práci'],
  ['desktop-v3/decision', 'žádá o rozhodnutí'],
  ['desktop-v3/agent-messages', 'nechal zprávu'],
  ['canvas-plan', 'rozvrhl karty'],
  ['graph', 'přeskládal canvas'],
  ['drawing', 'kreslil'],
  ['project-architecture', 'změnil architekturu'],
];

/** What a write to Opora's API was, in words; a refused one says so. */
export function describeActivity(method: string, path: string, status: number): string {
  const p = path.replace(/^\/api\//, '');
  const what = WORDS.find(([start]) => p.startsWith(start))?.[1] ?? `${method} ${p}`.slice(0, 60);
  return status >= 400 ? `${what} (odmítnuto, ${status})` : what;
}

/**
 * The live part of a floor's link to Opora: what the agents did on the canvas, read every few
 * seconds (the cards themselves are read far less often, see OporaBridge.poll), for the board.
 */
export class ActivityFeed {
  private entries: OporaActivity[] = [];
  private timer: NodeJS.Timeout;
  private reading = false;

  constructor(
    private client: OporaClient,
    /** The floor's project and workspace on Opora, once it's linked. */
    private where: () => { project?: string; workspace?: string },
    private changed: () => void,
  ) {
    this.timer = setInterval(() => void this.read(), LIVE_MS);
  }

  list(): OporaActivity[] {
    return this.entries.map((e) => ({ ...e, nodeIds: [...e.nodeIds] }));
  }

  async read() {
    const { project, workspace } = this.where();
    if (this.reading) return;
    if (!project || !workspace) {
      if (this.entries.length) {
        this.entries = [];
        this.changed();
      }
      return;
    }
    this.reading = true;
    try {
      const rows = await this.client.activity(project, workspace, KEEP);
      // The floor moved to another project or workspace while it read: those rows are the old one's.
      const now = this.where();
      if (now.project !== project || now.workspace !== workspace) return;
      const next = rows.map((r) => ({ id: r.id, at: r.at, agent: r.agent, what: describeActivity(r.method, r.path, r.status), nodeIds: r.nodeIds, ok: r.status < 400 }));
      if (next.map((e) => e.id).join() !== this.entries.map((e) => e.id).join()) {
        this.entries = next;
        this.changed();
      }
    } catch {
      // Opora not answering shows on the bridge's own read
    } finally {
      this.reading = false;
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}
