import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EMPTY_OPORA, OPORA_LIMITS, deskFor, frontierCards, oporaAgentName, oporaEmbedPolicy, sameDir } from '../../shared/opora.js';
import { fillPrompt, type PromptId } from '../../shared/prompts.js';
import type { DeskLabel } from '../../shared/floorplan.js';
import type { OporaCard, OporaRun, OporaState, WorkerInfo } from '../../shared/protocol.js';
import { forgetForOpora, markForOpora, seatForOpora, withReaBrief } from '../rea/index.js';
import { OporaClient, OporaError } from './client.js';
import { oporaProcess } from './process.js';
import { describeSketches, oporaCardViews, readSketches, sketchesLine } from './sketches.js';

/** What the bridge needs from the floor: its workers and desks, narrow so a test can fake it. */
export interface BridgeFloor {
  /** The floor's id and its checkout, which an Opora project plans when its folder is this one. */
  readonly id: string;
  readonly dir: string;
  list(): WorkerInfo[];
  /** Seats a worker at `deskId`, in its own worktree when the project is a git repo. */
  seat(deskId: string, by: string, prompt: string, owner?: string): WorkerInfo | string;
  /** The desks a worker can be hired at now, in order (the back office's as far as it's built). */
  desks(): string[];
  deskOccupied(deskId: string): boolean;
  labels(): Record<string, DeskLabel>;
}

export interface BridgeEvents {
  update(state: OporaState): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
  prompt(id: PromptId): string;
}

/** The office's side of a card it took: what it needs to keep the lease and let it go. */
interface Held extends OporaRun {
  token?: string;
  owner?: string;
}

const POLL_MS = 20_000;
const HEARTBEAT_MS = 5 * 60_000;
const LEASE_TTL = 900;
/** How many finished runs stay in the list. */
const KEEP_GONE = 12;
/** Sectors read each poll, at most. */
const MAX_SECTORS = 40;

/**
 * The 🧭 Opora Control Center's link to Opora Canvas, one for each floor. Opora is where the work is
 * planned: areas, sectors and cards, each card with its brief and its pipeline. The bridge reads the
 * canvas of the Opora project picked for this floor in the window, or else the one whose folder is
 * this floor's checkout, and carries its cards out: taking
 * one claims its lease on Opora and seats a worker for it, at a designer's desk for a card on the
 * design pipeline and a developer's for the rest (by the signs over the desks). The worker reads the
 * brief, does the work and reports back to Opora itself; the bridge keeps the lease alive while it
 * works and lets it go once it's gone home. With the autopilot on, it takes free cards by itself.
 */
export class OporaBridge {
  private state: OporaState;
  private runs: Held[] = [];
  private autopilotOwner?: string;
  private autopilotBy = '';
  /** The Opora project someone picked for this floor in the window, which wins over the folder's. */
  private chosen?: string;
  /** The workspace of the linked project someone picked in the window, which wins over `main` while it's still there. */
  private chosenWorkspace?: string;
  /** The project whose folder is this floor's checkout, as of the last read. */
  private byFolder?: string;
  private client: OporaClient;
  private statePath: string;
  private pollTimer: NodeJS.Timeout;
  private beatTimer: NodeJS.Timeout;
  /** The read under way, which another call to poll waits for rather than starting a second. */
  private polling?: Promise<void>;
  private stopped = false;

  constructor(
    private floor: BridgeFloor,
    dataDir: string,
    private events: BridgeEvents,
    url = process.env.AGENT_OFFICE_OPORA_URL || EMPTY_OPORA.url,
  ) {
    this.client = new OporaClient(url, `office-${floor.id}`);
    this.state = { ...EMPTY_OPORA, url, canStart: oporaProcess.canStart() };
    this.statePath = path.join(dataDir, 'opora.json');
    this.restore();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.beatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    void this.poll();
  }

  view(): OporaState {
    return { ...this.state, runs: this.runs.map(({ token: _t, owner: _o, ...r }) => ({ ...r })), canStart: oporaProcess.canStart(), starting: oporaProcess.starting };
  }

  /** Reads the canvas again: the floor's Opora project, its sectors and their cards. */
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.polling ??= this.pollOnce().finally(() => (this.polling = undefined));
    return this.polling;
  }

  /** Reads the canvas again once the read under way is done, for a change it started too early to see. */
  async repoll(): Promise<void> {
    await this.polling;
    await this.poll();
  }

  /**
   * Links the floor to an Opora project of someone's choosing, or (null) back to the one whose folder
   * is the floor's. Returns why it can't: while the office holds cards of one project, it stays on it.
   */
  link(projectId: string | null): string | undefined {
    if (projectId !== null && !this.state.projects.some((p) => p.id === projectId)) return this.state.connected ? 'That project isn’t on Opora' : (this.state.error ?? 'Opora isn’t answering');
    const target = projectId ?? this.byFolder;
    const held = this.runs.filter((r) => r.state !== 'gone').length;
    if (held && target !== this.state.project?.id) return `The office is on ${held} card${held === 1 ? '' : 's'} of ${this.state.project?.name ?? 'the linked project'}: let ${held === 1 ? 'it' : 'them'} finish (or send the workers home) before linking the floor to another project`;
    // Another project has other workspaces: it starts on its default one.
    if (target !== this.state.project?.id) this.chosenWorkspace = undefined;
    this.chosen = projectId ?? undefined;
    this.changed();
    return undefined;
  }

  /**
   * Reads another workspace of the linked project (a work one, where the planning happens, as `main`
   * is read-only for a git project), or (null) the default one. Cards the office holds stay in theirs.
   */
  useWorkspace(workspaceId: string | null): string | undefined {
    if (workspaceId !== null && !this.state.workspaces.some((w) => w.id === workspaceId)) return this.state.project ? `That workspace isn’t in ${this.state.project.name} on Opora` : (this.state.error ?? 'Opora isn’t linked to this floor');
    this.chosenWorkspace = workspaceId ?? undefined;
    this.changed();
    return undefined;
  }

  private async pollOnce(): Promise<void> {
    try {
      // A worker that went home while the office was down never said so.
      const here = new Set(this.floor.list().map((w) => w.id));
      for (const run of this.runs) {
        if (run.state === 'gone' || (run.workerId && here.has(run.workerId))) continue;
        run.state = 'gone';
        void this.letGo(run);
      }
      await this.read();
      if (this.state.autopilot) await this.autopilot();
    } finally {
      this.changed();
    }
  }

  /** Takes a free card: claims its lease and seats a worker for it. Resolves to why it couldn't, if it couldn't. */
  async take(cardId: string, by: string, owner?: string): Promise<string | undefined> {
    const { project, workspace } = this.state;
    if (!this.state.connected || !project || !workspace) return this.state.error ?? 'Opora isn’t linked to this floor';
    const card = this.state.cards.find((c) => c.id === cardId);
    if (!card) return 'That card isn’t on the canvas any more';
    if (card.status !== 'frontier') return `“${card.name}” isn’t free to take (${card.status})`;
    if (this.runs.some((r) => r.cardId === cardId && r.state !== 'gone')) return `The office is already on “${card.name}”`;
    const desk = deskFor(card.group, card.sectorName, this.floor.desks(), this.floor.labels(), (d) => this.floor.deskOccupied(d));
    if (!desk) return 'Every desk is taken: send someone home, or build the back office out';
    const agent = oporaAgentName(this.floor.id, card.id);
    let lease;
    try {
      lease = await this.client.claim(project.id, workspace, card.id, agent, LEASE_TTL);
    } catch (err) {
      return err instanceof OporaError && err.status === 409 ? `Someone else holds “${card.name}” on Opora` : (err as Error).message;
    }
    // What the person sketched for the card (its drawing, its storyboard), and the Opora pages that show it.
    const sketches = await readSketches(this.client, project.id, workspace, card.id);
    const views = oporaCardViews(this.state.url, project.id, workspace, card.id);
    const where = { node: card.id, base: this.state.url, project: project.id, workspace };
    const design = card.group === 'design' ? fillPrompt(this.events.prompt('opora.design'), { ...where, card: card.name, ...views, found: describeSketches(sketches) }) : '';
    const prompt = fillPrompt(this.events.prompt('opora.card'), {
      ...where,
      card: card.name,
      sector: card.sectorName ?? '—',
      agent,
      token: lease.token,
      sketches: design ? '' : sketchesLine(sketches, views, project.id, workspace, card.id),
      design,
    });
    // 🔬 REA, when it's on: its MCP server for taking a reference app apart, and how to use it (see rea/).
    const seated = seatForOpora(() => this.floor.seat(desk, by, withReaBrief(prompt, this.events.prompt), owner));
    if (typeof seated === 'string') {
      await this.client.release(project.id, workspace, card.id, lease.token).catch(() => undefined);
      return seated;
    }
    this.runs.unshift({
      cardId: card.id,
      cardName: card.name,
      ...(card.sectorName ? { sectorName: card.sectorName } : {}),
      group: card.group,
      workerId: seated.id,
      workerName: seated.name,
      deskId: desk,
      by,
      startedAt: Date.now(),
      state: 'working',
      ...(lease.expiresAt ? { leaseUntil: lease.expiresAt } : {}),
      workspace,
      token: lease.token,
      owner: agent,
    });
    card.status = 'claimed';
    this.changed();
    this.events.toast(`🛰️ ${seated.name} took “${card.name}” from the Opora canvas${card.group === 'design' ? ' (design)' : ''}`, 'info');
    return undefined;
  }

  setAutopilot(on: boolean, maxRuns: number | undefined, by: string, owner?: string) {
    this.state.autopilot = on;
    if (maxRuns !== undefined && Number.isFinite(maxRuns)) this.state.maxRuns = Math.max(1, Math.min(OPORA_LIMITS.maxRuns, Math.floor(maxRuns)));
    if (on) {
      this.autopilotBy = by;
      this.autopilotOwner = owner;
    }
    this.changed();
    this.events.toast(on ? `🛰️ ${by} put the Opora autopilot on: the office takes free cards by itself, ${this.state.maxRuns} at a time` : `🛰️ ${by} put the Opora autopilot off`, 'info');
    if (on) void this.poll();
  }

  onWorker(info: WorkerInfo) {
    const run = this.runs.find((r) => r.workerId === info.id && r.state !== 'gone');
    if (!run) return;
    const state = info.status === 'done' || info.status === 'exited' ? 'done' : 'working';
    if (run.state === state) return;
    run.state = state;
    this.changed();
  }

  onWorkerGone(workerId: string) {
    const run = this.runs.find((r) => r.workerId === workerId && r.state !== 'gone');
    if (!run) return;
    run.state = 'gone';
    forgetForOpora(workerId);
    void this.letGo(run);
    this.trim();
    this.changed();
  }

  shutdown() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.beatTimer);
    this.persist();
  }

  private async read() {
    const s = this.state;
    try {
      await this.client.health();
    } catch (err) {
      Object.assign(s, { connected: false, embeddable: false, embedOrigins: undefined, error: (err as Error).message, project: null, linkedBy: undefined, projects: [], workspace: null, workspaces: [], workspaceBy: undefined, sectors: [], cards: [], checkedAt: Date.now() });
      return;
    }
    // Whether Opora lets the office frame it, for O at the boss's chair to open it inside the office.
    try {
      const h = await this.client.frameHeaders();
      Object.assign(s, { embedOrigins: undefined, ...oporaEmbedPolicy(h.xFrameOptions, h.csp) });
    } catch {
      Object.assign(s, { embeddable: false, embedOrigins: undefined });
    }
    try {
      const all = await this.client.projects();
      s.projects = all.map((p) => ({ id: p.id, name: p.name }));
      const byFolder = all.find((p) => p.sourcePath && sameDir(p.sourcePath, this.floor.dir));
      this.byFolder = byFolder?.id;
      // A project someone picked wins; if it's gone from Opora, the folder's is next, and the window says so.
      const chosen = this.chosen ? all.find((p) => p.id === this.chosen) : undefined;
      const lost = this.chosen && !chosen ? `The project this floor was linked to (${this.chosen}) isn't on Opora any more: ${byFolder ? `reading ${byFolder.name}, the one for this floor's folder, instead` : 'pick another'}` : undefined;
      const project = chosen ?? byFolder;
      if (!project) {
        Object.assign(s, { connected: true, error: lost ?? `No Opora project plans this floor's folder (${this.floor.dir}): pick one in the 🛰️ Opora window, or add the folder in Opora as a local or git project`, project: null, linkedBy: undefined, workspace: null, workspaces: [], workspaceBy: undefined, sectors: [], cards: [], checkedAt: Date.now() });
        return;
      }
      // The workspace someone picked while it's still there, else `main`, else the first; a picked one that's gone says so.
      const workspaces = await this.client.workspaces(project.id);
      const picked = this.chosenWorkspace ? workspaces.find((w) => w.id === this.chosenWorkspace) : undefined;
      const workspace = picked?.id ?? (workspaces.some((w) => w.id === 'main') ? 'main' : (workspaces[0]?.id ?? 'draft'));
      const gone = this.chosenWorkspace && !picked ? `The workspace this floor was set to (${this.chosenWorkspace}) isn't in ${project.name} on Opora any more: reading ${workspaces.find((w) => w.id === workspace)?.label ?? workspace} instead, or pick another` : undefined;
      const nodes = await this.client.nodes(project.id, workspace);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const isCard = (id: string) => byId.get(id)?.kind === 'node';
      const sectors = nodes.filter((n) => n.kind === 'sector').slice(0, MAX_SECTORS);
      const cards: OporaCard[] = frontierCards(await this.client.frontier(project.id, workspace), isCard);
      const seen = new Set(cards.map((c) => c.id));
      for (const sector of sectors) {
        for (const c of frontierCards(await this.client.frontier(project.id, workspace, sector.id), isCard, { id: sector.id, name: sector.name })) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          cards.push(c);
        }
      }
      Object.assign(s, { connected: true, error: [lost, gone].filter(Boolean).join(' · ') || undefined, project: { id: project.id, name: project.name }, linkedBy: chosen ? 'choice' : 'folder', workspace, workspaces, workspaceBy: picked ? 'choice' : 'default', sectors: sectors.map((x) => ({ id: x.id, name: x.name })), cards, checkedAt: Date.now() });
    } catch (err) {
      Object.assign(s, { connected: true, error: (err as Error).message, checkedAt: Date.now() });
    }
  }

  /** Takes free cards while there's room under the limit, the routed ones first. */
  private async autopilot() {
    const busy = () => this.runs.filter((r) => r.state !== 'gone').length;
    const free = this.state.cards.filter((c) => c.status === 'frontier' && c.profile && !this.runs.some((r) => r.cardId === c.id && r.state !== 'gone'));
    for (const card of free) {
      if (busy() >= this.state.maxRuns) return;
      const err = await this.take(card.id, this.autopilotBy || 'Autopilot', this.autopilotOwner);
      if (err) {
        this.events.toast(`🛰️ The autopilot couldn't take “${card.name}”: ${err}`, 'warn');
        return;
      }
    }
  }

  private async heartbeat() {
    const { project } = this.state;
    if (!project) return;
    for (const run of this.runs) {
      // A run keeps the workspace it was leased in; one saved before runs had theirs is in the floor's.
      const workspace = run.workspace ?? this.state.workspace;
      if (run.state === 'gone' || !run.token || !workspace) continue;
      try {
        run.leaseUntil = (await this.client.heartbeat(project.id, workspace, run.cardId, run.token, LEASE_TTL)).expiresAt ?? run.leaseUntil;
        run.error = undefined;
      } catch (err) {
        run.error = (err as Error).message;
      }
    }
    this.changed();
  }

  /** Lets the card's lease go, if the worker didn't itself (an error then is the lease being gone already). */
  private async letGo(run: Held) {
    const { project } = this.state;
    const workspace = run.workspace ?? this.state.workspace;
    if (!project || !workspace || !run.token) return;
    await this.client.release(project.id, workspace, run.cardId, run.token).catch(() => undefined);
    run.token = undefined;
    this.persist();
  }

  private trim() {
    const gone = this.runs.filter((r) => r.state === 'gone');
    if (gone.length > KEEP_GONE) this.runs = this.runs.filter((r) => r.state !== 'gone' || gone.indexOf(r) < KEEP_GONE);
  }

  private changed() {
    this.persist();
    this.events.update(this.view());
  }

  private persist() {
    try {
      writeFileSync(this.statePath, JSON.stringify({ runs: this.runs, autopilot: this.state.autopilot, maxRuns: this.state.maxRuns, autopilotBy: this.autopilotBy, autopilotOwner: this.autopilotOwner, linkedTo: this.chosen, workspace: this.chosenWorkspace }, null, 2), { mode: 0o600 });
    } catch {
      // a full disk loses the bridge's state, not the office
    }
  }

  private restore() {
    try {
      if (!existsSync(this.statePath)) return;
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { runs?: Held[]; autopilot?: boolean; maxRuns?: number; autopilotBy?: string; autopilotOwner?: string; linkedTo?: string; workspace?: string };
      if (Array.isArray(saved.runs)) this.runs = saved.runs.filter((r) => r && typeof r.cardId === 'string');
      for (const r of this.runs) if (r.state !== 'gone' && r.workerId) markForOpora(r.workerId);
      this.state.autopilot = saved.autopilot === true;
      if (typeof saved.maxRuns === 'number') this.state.maxRuns = Math.max(1, Math.min(OPORA_LIMITS.maxRuns, saved.maxRuns));
      this.autopilotBy = typeof saved.autopilotBy === 'string' ? saved.autopilotBy : '';
      this.autopilotOwner = typeof saved.autopilotOwner === 'string' ? saved.autopilotOwner : undefined;
      this.chosen = typeof saved.linkedTo === 'string' && saved.linkedTo ? saved.linkedTo : undefined;
      this.chosenWorkspace = typeof saved.workspace === 'string' && saved.workspace ? saved.workspace : undefined;
    } catch {
      // a broken file starts the bridge afresh
    }
  }
}
