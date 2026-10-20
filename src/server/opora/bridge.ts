import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EMPTY_OPORA, OPORA_LIMITS, deskFor, frontierCards, oporaAgentName, oporaEmbedPolicy, sameDir } from '../../shared/opora.js';
import { buildScope, cleanFocus, focusLine, inFocus, toggleFocus, type CanvasNode } from '../../shared/opora-scope.js';
import { focusIntact, samePlace, type OporaPlace } from '../../shared/opora-identity.js';
import { fillPrompt, type PromptId } from '../../shared/prompts.js';
import type { DeskLabel } from '../../shared/floorplan.js';
import type { OporaCard, OporaRun, OporaState, WorkerInfo } from '../../shared/protocol.js';
import { forgetForOpora, markForOpora, seatForOpora, withReaBrief } from '../rea/index.js';
import { OporaClient, OporaError } from './client.js';
import { ActivityFeed } from './live.js';
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
  /**
   * The orchestrator at the Opora Control Center's table while it's on a plan onto Opora (planning
   * onto the canvas or routing it, until the room is cleared): who asked for it, whose sign-ins its
   * cards' workers run on.
   */
  orchestrator?(): { by: string; owner?: string } | undefined;
}

export interface BridgeEvents {
  /** Optional task context, prepared before claiming a lease from the canvas as last read; failure prevents dispatch. */
  prepareTask?(project: string, workspace: string, card: string, owner: string | undefined, nodes: readonly CanvasNode[]): Promise<string>;
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
  /** What the cell works on, as switched at the 🎚️ switchboard (see shared/opora-scope.ts). */
  private focus: string[] = [];
  /** The project and workspace the focus was switched on in: node ids mean nothing in another (docs/opora-identity.md). */
  private focusPlace?: OporaPlace;
  /** The cards that were ready at the last read, of the project and workspace in `readyOf`, to see which turn ready next. */
  private ready?: Set<string>;
  private readyOf = '';
  /** The orchestrator's cards waiting to be handed out, with who asked for its plan. */
  private handed = new Map<string, { by: string; owner?: string; warned?: boolean }>();
  /** What the agents did on the canvas lately, read more often than the cards, for the live canvas. */
  private live: ActivityFeed;
  /** The project whose folder is this floor's checkout, as of the last read. */
  private byFolder?: string;
  /** The canvas as last read, every node with its parent and area, for what resolves a card's place in it (the Harness cascade). */
  private canvas: CanvasNode[] = [];
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
    this.live = new ActivityFeed(this.client, () => ({ project: this.state.project?.id, workspace: this.state.workspace ?? undefined }), () => this.events.update(this.view()));
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.beatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    void this.poll();
  }

  view(): OporaState {
    const focus = this.state.scope.length ? cleanFocus(this.state.scope, this.focus) : [...this.focus];
    return { ...this.state, focus, activity: this.live.list(), handOutWaiting: [...this.handed.keys()], runs: this.runs.map(({ token: _t, owner: _o, ...r }) => ({ ...r })), canStart: oporaProcess.canStart(), starting: oporaProcess.starting };
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
    // Another project has other workspaces and another architecture: it starts on its default one, on the whole of it.
    if (target !== this.state.project?.id) {
      this.chosenWorkspace = undefined;
      this.focus = [];
    }
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

  /**
   * Switches one node of what the cell works on: on with everything above it, off with everything
   * under it, or (`only`) just it; a null id is the whole project. The cell then takes only cards in
   * the focus, and its planner is told to stay in it. Each switch is applied to the focus as it is
   * now, so two people switching at once both count.
   */
  switchFocus(id: string | null, on: boolean, only: boolean, by: string): string | undefined {
    const scope = this.state.scope;
    if (!scope.length) return this.state.error ?? 'The project’s architecture isn’t read yet';
    if (id !== null && !scope.some((n) => n.id === id)) return 'That isn’t in the project’s architecture any more: look again';
    // A focus from another workspace isn't added to: its ids are other cards there.
    const kept = only || (this.focusPlace && !samePlace(this.focusPlace, this.place())) ? [] : this.focus;
    this.focus = id === null ? [] : toggleFocus(scope, kept, id, on || only);
    this.focusPlace = this.place();
    this.changed();
    const line = focusLine(this.state.scope, this.focus);
    this.events.toast(line ? `🎚️ ${by} set the cell to work on ${line}` : `🎚️ ${by} set the cell to work on the whole project`, 'info');
    return undefined;
  }

  /** The linked project and workspace, once read. */
  private place(): OporaPlace | undefined {
    const { project, workspace } = this.state;
    return project && workspace ? { project: project.id, workspace } : undefined;
  }

  /**
   * Why the cell takes nothing while its focus doesn't mean what it meant when it was switched on: a
   * node of it left the architecture or moved (the cards were removed or the canvas laid out anew),
   * or it was switched on in another workspace, whose same node ids are other cards. The cell
   * refuses instead of falling back to the whole project or to what's left of the focus.
   */
  private focusLost(): string | undefined {
    const scope = this.state.scope;
    if (!this.focus.length || !scope.length) return undefined;
    if (this.focusPlace && !samePlace(this.focusPlace, this.place())) return 'What the cell works on was switched on in another workspace: switch it again at the 🎚️ switchboard';
    if (focusIntact(scope, this.focus)) return undefined;
    return 'What the cell works on isn’t in the project’s architecture any more, or not where it was: switch it again at the 🎚️ switchboard';
  }

  /** The canvas's nodes as last read (docs/opora-identity.md): what places a node in the hierarchy. */
  canvasNodes(): readonly CanvasNode[] {
    return this.canvas;
  }

  /** The focus in words for a brief, or '' for the whole project. */
  focusLine(): string {
    return focusLine(this.state.scope, this.focus);
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
      if (this.state.handOut) await this.handOut();
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
    const lost = this.focusLost();
    if (lost) return lost;
    if (!inFocus(this.state.scope, this.focus, card.id)) return `“${card.name}” is outside what the cell works on: switch it on at the 🎚️ switchboard first`;
    if (card.status !== 'frontier') return `“${card.name}” isn’t free to take (${card.status})`;
    if (this.runs.some((r) => r.cardId === cardId && r.state !== 'gone')) return `The office is already on “${card.name}”`;
    const desk = deskFor(card.group, card.sectorName, this.floor.desks(), this.floor.labels(), (d) => this.floor.deskOccupied(d));
    if (!desk) return 'Every desk is taken: send someone home, or build the back office out';
    const agent = oporaAgentName(this.floor.id, card.id);
    let context = '';
    try { context = await this.events.prepareTask?.(project.id, workspace, card.id, owner, this.canvas) ?? ''; }
    catch (err) { return 'Task context: ' + (err as Error).message; }
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
    const seated = seatForOpora(() => this.floor.seat(desk, by, withReaBrief(prompt + context, this.events.prompt), owner));
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

  setHandOut(on: boolean, by: string) {
    this.state.handOut = on;
    if (!on) this.handed.clear();
    this.changed();
    this.events.toast(on ? `🧭 ${by} has the orchestrator's cards handed out to the departments as they come` : `🧭 ${by} stopped handing the orchestrator's cards out: take them by hand`, 'info');
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
    this.live.stop();
    this.persist();
  }

  private async read() {
    const s = this.state;
    try {
      await this.client.health();
    } catch (err) {
      Object.assign(s, { connected: false, embeddable: false, embedOrigins: undefined, error: (err as Error).message, project: null, linkedBy: undefined, projects: [], workspace: null, workspaces: [], workspaceBy: undefined, sectors: [], cards: [], scope: [], checkedAt: Date.now() });
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
        Object.assign(s, { connected: true, error: lost ?? `No Opora project plans this floor's folder (${this.floor.dir}): pick one in the 🛰️ Opora window, or add the folder in Opora as a local or git project`, project: null, linkedBy: undefined, workspace: null, workspaces: [], workspaceBy: undefined, sectors: [], cards: [], scope: [], checkedAt: Date.now() });
        return;
      }
      // The workspace someone picked while it's still there, else `main`, else the first; a picked one that's gone says so.
      const workspaces = await this.client.workspaces(project.id);
      const picked = this.chosenWorkspace ? workspaces.find((w) => w.id === this.chosenWorkspace) : undefined;
      const workspace = picked?.id ?? (workspaces.some((w) => w.id === 'main') ? 'main' : (workspaces[0]?.id ?? 'draft'));
      const gone = this.chosenWorkspace && !picked ? `The workspace this floor was set to (${this.chosenWorkspace}) isn't in ${project.name} on Opora any more: reading ${workspaces.find((w) => w.id === workspace)?.label ?? workspace} instead, or pick another` : undefined;
      // Another project (its folder's, as the one picked left Opora) has another architecture: the whole of it.
      if (s.project && s.project.id !== project.id) this.focus = [];
      const nodes = await this.client.nodes(project.id, workspace);
      this.canvas = nodes;
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
      this.noteReady(`${project.id}/${workspace}`, cards);
      Object.assign(s, { connected: true, error: [lost, gone].filter(Boolean).join(' · ') || undefined, project: { id: project.id, name: project.name }, linkedBy: chosen ? 'choice' : 'folder', workspace, workspaces, workspaceBy: picked ? 'choice' : 'default', sectors: sectors.map((x) => ({ id: x.id, name: x.name })), cards, scope: buildScope(nodes), checkedAt: Date.now() });
      // Judged on the architecture and workspace just read, not the ones before.
      const focusLost = this.focusLost();
      if (focusLost) s.error = [s.error, focusLost].filter(Boolean).join(' · ');
    } catch (err) {
      Object.assign(s, { connected: true, error: (err as Error).message, checkedAt: Date.now() });
    }
  }

  /**
   * Marks the cards that turned ready since the last read as the orchestrator's while it's on a plan
   * onto Opora: it laid them out, or routed them. The first read (or one of another workspace) only
   * notes what's ready, so the cards that were there before aren't taken for its.
   */
  private noteReady(of: string, cards: OporaCard[]) {
    const now = new Set(cards.filter((c) => c.status === 'frontier').map((c) => c.id));
    const orchestrator = this.floor.orchestrator?.();
    if (this.ready && this.readyOf === of && orchestrator) for (const id of now) if (!this.ready.has(id)) this.handed.set(id, { ...orchestrator });
    if (this.readyOf !== of) this.handed.clear();
    this.ready = now;
    this.readyOf = of;
  }

  /**
   * Hands the orchestrator's ready cards out, each to a worker of its department (see deskFor), while
   * there's room under the limit; a card someone else took, or that left the canvas, is let go.
   */
  private async handOut() {
    for (const [id, who] of [...this.handed]) {
      const card = this.state.cards.find((c) => c.id === id);
      if (!card || card.status !== 'frontier' || this.runs.some((r) => r.cardId === id && r.state !== 'gone')) {
        if (!card || card.status === 'claimed' || card.status === 'closed') this.handed.delete(id);
        continue;
      }
      if (this.runs.filter((r) => r.state !== 'gone').length >= this.state.maxRuns) return;
      const err = await this.take(id, who.by, who.owner);
      if (!err) {
        this.handed.delete(id);
        continue;
      }
      // Outside the focus it's not the cell's to do; no desk free is for the next read.
      if (/outside what the cell works on/.test(err)) this.handed.delete(id);
      else {
        if (!who.warned) this.events.toast(`🧭 The orchestrator's “${card.name}” waits for a department: ${err}`, 'warn');
        who.warned = true;
        return;
      }
    }
  }

  /** Takes free cards while there's room under the limit, the routed ones first. */
  private async autopilot() {
    if (this.focusLost()) return;
    const busy = () => this.runs.filter((r) => r.state !== 'gone').length;
    const free = this.state.cards.filter((c) => c.status === 'frontier' && c.profile && inFocus(this.state.scope, this.focus, c.id) && !this.runs.some((r) => r.cardId === c.id && r.state !== 'gone'));
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
      writeFileSync(this.statePath, JSON.stringify({ runs: this.runs, autopilot: this.state.autopilot, maxRuns: this.state.maxRuns, autopilotBy: this.autopilotBy, autopilotOwner: this.autopilotOwner, linkedTo: this.chosen, workspace: this.chosenWorkspace, focus: this.focus, focusPlace: this.focusPlace, handOut: this.state.handOut }, null, 2), { mode: 0o600 });
    } catch {
      // a full disk loses the bridge's state, not the office
    }
  }

  private restore() {
    try {
      if (!existsSync(this.statePath)) return;
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { runs?: Held[]; autopilot?: boolean; maxRuns?: number; autopilotBy?: string; autopilotOwner?: string; linkedTo?: string; workspace?: string; focus?: unknown; focusPlace?: Partial<OporaPlace>; handOut?: boolean };
      if (Array.isArray(saved.runs)) this.runs = saved.runs.filter((r) => r && typeof r.cardId === 'string');
      for (const r of this.runs) if (r.state !== 'gone' && r.workerId) markForOpora(r.workerId);
      this.state.autopilot = saved.autopilot === true;
      this.state.handOut = saved.handOut !== false;
      if (typeof saved.maxRuns === 'number') this.state.maxRuns = Math.max(1, Math.min(OPORA_LIMITS.maxRuns, saved.maxRuns));
      this.autopilotBy = typeof saved.autopilotBy === 'string' ? saved.autopilotBy : '';
      this.autopilotOwner = typeof saved.autopilotOwner === 'string' ? saved.autopilotOwner : undefined;
      this.chosen = typeof saved.linkedTo === 'string' && saved.linkedTo ? saved.linkedTo : undefined;
      this.chosenWorkspace = typeof saved.workspace === 'string' && saved.workspace ? saved.workspace : undefined;
      this.focus = Array.isArray(saved.focus) ? saved.focus.filter((x): x is string => typeof x === 'string') : [];
      const at = saved.focusPlace;
      this.focusPlace = at && typeof at.project === 'string' && typeof at.workspace === 'string' ? { project: at.project, workspace: at.workspace } : undefined;
    } catch {
      // a broken file starts the bridge afresh
    }
  }
}
