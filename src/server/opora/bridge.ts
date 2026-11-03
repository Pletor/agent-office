import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EMPTY_OPORA, OPORA_LIMITS, cardGroup, deskFor, oporaEmbedPolicy, sameDir } from '../../shared/opora.js';
import { buildScope, cleanFocus, focusLine, placeCards, toggleFocus } from '../../shared/opora-scope.js';
import { type PromptId } from '../../shared/prompts.js';
import type { DeskLabel } from '../../shared/floorplan.js';
import type { OporaCard, OporaRun, OporaState, WorkerInfo } from '../../shared/protocol.js';
import { forgetForOpora, markForOpora, seatForOpora, withReaBrief } from '../rea/index.js';
import { OporaClient } from './client.js';
import { ActivityFeed } from './live.js';
import { oporaProcess } from './process.js';
import { ExecutionDispatch, type ExecutionHeld } from './execution-dispatch.js';
import { requestExecutionStop } from './execution-stop.js';
import { prepareDesignBrief } from './design-brief.js';
import type { CardModel } from './card-model.js';
import type { StagedWorker } from '../workers/staged-start.js';
import { createReviewRunner, type ReviewJobRunner } from './review-runner.js';
import { createOporaUpkeep, type OporaUpkeep } from './upkeep-runner.js';
import { createSelfCheckReporter, upkeepSelfChecks, type SelfCheckReporter } from './self-checks.js';
import { processProbe, waitForQuiet, workerProbe } from './worktree-quiet.js';
import { floorCheckEnv } from './floor-checks.js';
import { runRequestedSelfChecks } from './self-check-requests.js';
import { gitRunner } from './upkeep-tools.js';
import { WorktreeSetup } from '../workers/worktree-setup.js';
import { upkeepTap } from '../process/taps.js';
import { GateError, TicketGate, ticketBrief, type GateScope, type WorkerTicket } from './ticket-gate.js';
import { pendingFeedback, writeNotes } from './ticket-feedback.js';

/** What the bridge needs from the floor: its workers and desks, narrow so a test can fake it. */
export interface BridgeFloor {
  /** The floor's id and its checkout, which an Opora project plans when its folder is this one. */
  readonly id: string;
  readonly dir: string;
  list(): WorkerInfo[];
  stop?(workerId: string): Promise<unknown>;
  /** Seats a worker at `deskId`, in its own worktree when the project is a git repo. */
  seat(deskId: string, by: string, prompt: string, owner?: string, cardModel?: CardModel): WorkerInfo | string;
  prepareWorker?(deskId: string, by: string, owner?: string): Promise<StagedWorker>;
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
  /** Optional task context, prepared before claiming a lease; failure prevents dispatch. */
  prepareTask?(project: string, workspace: string, card: string, owner?: string): Promise<string>;
  update(state: OporaState): void;
  /** The floor was linked to another project: what was picked in the old one (the orchestrator's card) goes. */
  relinked?(): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
  prompt(id: PromptId): string;
}

/** The office's side of a card it took: what it needs to keep the lease and let it go. */
interface Held extends OporaRun, Omit<ExecutionHeld, 'state'> {
  token?: string;
  owner?: string;
  /** The OPORA ticket the run works on (ticket-gate.ts), kept across a restart with the run. */
  ticketId?: string;
  /** `ticket.deliver` went through. */
  ticketDelivered?: boolean;
  /** How many of the worker's queued feedback items went to the gate (ticket-feedback.ts). */
  ticketFeedbackSent?: number;
}

const POLL_MS = 20_000;
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
 * works and lets it go once it's gone home. Work comes as tickets from OPORA's heart through its brain gate
 * (ticket-gate.ts, Canvas docs/navrhy/2026-11-03-novy-zaklad.md §3.3): the office asks for one, starts the
 * card's execution, claims the ticket for it, seats a worker, relays the worker's feedback and delivers it.
 */
export class OporaBridge {
  private state: OporaState;
  private runs: Held[] = [];
  /** The Opora project someone picked for this floor in the window, which wins over the folder's. */
  private chosen?: string;
  /** The workspace of the linked project someone picked in the window, which wins over `main` while it's still there. */
  private chosenWorkspace?: string;
  /** The workspace of the heart's last accepted plan, as read from Opora at the last poll. */
  private heartWorkspace?: string;
  /** What the cell works on, as switched at the 🎚️ switchboard (see shared/opora-scope.ts). */
  private focus: string[] = [];
  /** What the agents did on the canvas lately, read more often than the cards, for the live canvas. */
  private live: ActivityFeed;
  /** The project whose folder is this floor's checkout, as of the last read. */
  private byFolder?: string;
  private client: OporaClient;
  /** OPORA's brain gate, where the tickets come from (ticket-gate.ts). */
  private gate: TicketGate;
  /** Each ticket a gate refusal was already said for, so a poll doesn't repeat it. */
  private ticketSaid = new Set<string>();
  /** Tickets whose `ticket.deliver` is on its way, so hand-offs joining it don't send it twice. */
  private delivering = new Set<string>();
  private statePath: string;
  private pollTimer: NodeJS.Timeout;
  readonly executions: ExecutionDispatch;
  /** Review workers for the linked project's review jobs, while AGENT_OFFICE_OPORA_REVIEWS is on (review-runner.ts). */
  readonly reviews?: ReviewJobRunner;
  /** PR upkeep and the post-merge guard, while AGENT_OFFICE_OPORA_UPKEEP or _GUARD is on (upkeep-runner.ts). */
  readonly upkeep?: OporaUpkeep;
  /** The read under way, which another call to poll waits for rather than starting a second. */
  private polling?: Promise<void>;
  /** Self-check evidence for the heads the office hands off, while AGENT_OFFICE_OPORA_SELF_CHECKS names checks (self-checks.ts). */
  private selfChecks?: SelfCheckReporter;
  private stopped = false;

  constructor(
    private floor: BridgeFloor,
    private dataDir: string,
    private events: BridgeEvents,
    url = process.env.AGENT_OFFICE_OPORA_URL || EMPTY_OPORA.url,
  ) {
    this.client = new OporaClient(url, `office-${floor.id}`);
    this.gate = new TicketGate(url, { name: `office-${floor.id}`, office: 'agent-office', floor: floor.id });
    this.state = { ...EMPTY_OPORA, url, canStart: oporaProcess.canStart() };
    this.statePath = path.join(dataDir, 'opora.json');
    const log = (message: string, level: 'info' | 'warn') => (level === 'info' ? console.log : console.warn)(`[opora] ${message}`);
    // The floor's own checks (`.agent-office/opora-checks.json`) win over the env vars (floor-checks.ts).
    const env = floorCheckEnv(dataDir, log);
    // Self-check evidence for every head the office hands off or upkeep pushes, while AGENT_OFFICE_OPORA_SELF_CHECKS names checks (self-checks.ts).
    const selfChecks = this.selfChecks = createSelfCheckReporter(url, `office-${floor.id}`, dataDir, log, env);
    // A worktree its setup never ran in (worktree-setup.ts) gets it first, so the checks don't fail on missing dependencies.
    if (selfChecks) { const setup = new WorktreeSetup(floor.dir); selfChecks.prepare = dir => setup.ensure(dir); }
    // Not while the worker that was in the worktree, or its processes, still run there (worktree-quiet.ts).
    if (selfChecks) selfChecks.settle = dir => waitForQuiet(dir, [workerProbe(() => floor.list(), floor.dir), processProbe]);
    this.executions = new ExecutionDispatch(url, `office-${floor.id}`, dataDir, () => this.runs,
      () => this.changed(), (id, reason) => {
        const run = this.runs.find(run => run.workerId === id);
        // A result ends authority, which stops the worker: its work goes out as a pull request first.
        if (run) this.handOff(run, this.floor.list().find(w => w.id === id));
        requestExecutionStop(run, id, reason, this.floor.stop?.bind(this.floor),
          () => this.changed(), message => this.events.toast(message, 'warn'));
      }, undefined, selfChecks);
    // Earlier runs' branches are in the floor's checkout: a resumed card picks up their step commits (execution-resume.ts).
    this.executions.floorDir = floor.dir;
    this.reviews = createReviewRunner(url, `office-${floor.id}`, floor.dir, dataDir, log);
    this.upkeep = createOporaUpkeep(floor.dir, dataDir, (message, level) => this.events.toast(message, level), env,
      selfChecks && upkeepSelfChecks(selfChecks, dataDir, () => this.linkedScope()),
      { base: url, agent: `office-${floor.id}`, linked: () => this.linkedScope() });
    if (this.upkeep) this.upkeep.observe = upkeepTap(floor.id);
    this.restore();
    this.live = new ActivityFeed(this.client, () => ({ project: this.state.project?.id, workspace: this.state.workspace ?? undefined }), () => this.events.update(this.view()));
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  /** The floor's linked Opora project and workspace, when it has both. */
  private linkedScope(): { project: string; workspace: string } | undefined {
    return this.state.project && this.state.workspace ? { project: this.state.project.id, workspace: this.state.workspace } : undefined;
  }

  view(): OporaState {
    const focus = this.state.scope.length ? cleanFocus(this.state.scope, this.focus) : [...this.focus];
    return { ...this.state, focus, activity: this.live.list(), runs: this.runs.map(({ token: _t, owner: _o, execution: _e, deadlineUnixMs: _d, ticketId: _k, ticketDelivered: _v, ticketFeedbackSent: _f, ...r }) => ({ ...r })), canStart: oporaProcess.canStart(), starting: oporaProcess.starting };
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
    const moved = target !== this.state.project?.id;
    if (moved) {
      this.chosenWorkspace = undefined;
      this.focus = [];
    }
    this.chosen = projectId ?? undefined;
    this.changed();
    if (moved) this.events.relinked?.();
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
    this.focus = id === null ? [] : toggleFocus(scope, only ? [] : this.focus, id, on || only);
    this.changed();
    const line = focusLine(this.state.scope, this.focus);
    this.events.toast(line ? `🎚️ ${by} set the cell to work on ${line}` : `🎚️ ${by} set the cell to work on the whole project`, 'info');
    return undefined;
  }

  /**
   * Why the cell takes nothing while it has a focus none of which is in the architecture any more
   * (the cards were removed or the canvas laid out anew), instead of falling back to the whole project.
   */
  private focusLost(): string | undefined {
    const scope = this.state.scope;
    if (!this.focus.length || !scope.length || cleanFocus(scope, this.focus).length) return undefined;
    return 'What the cell works on isn’t in the project’s architecture any more: switch it again at the 🎚️ switchboard';
  }

  /** The focus in words for a brief, or '' for the whole project. */
  focusLine(): string {
    return focusLine(this.state.scope, this.focus);
  }

  private async pollOnce(): Promise<void> {
    try {
      // A worker that went home while the office was down never said so.
      const here = new Set(this.floor.list().map((w) => w.id));
      for (const info of this.floor.list()) {
        const run = this.runs.find((r) => r.workerId === info.id);
        if (run) this.handOff(run, info);
      }
      for (const run of this.runs) {
        if (run.state === 'gone' || (run.workerId && here.has(run.workerId))) continue;
        run.state = 'gone';
        void this.letGo(run);
      }
      // Evidence Canvas didn't answer for, posted again as it was (never the checks again).
      void this.selfChecks?.retryPending();
      await this.read();
      if (this.state.connected && this.state.project && this.state.workspace) void this.reviews?.tick({ project: this.state.project.id, workspace: this.state.workspace });
      await this.tendTickets();
      await this.nextTicket();
    } finally {
      this.changed();
    }
  }

  /**
   * Starts the card's execution on Opora and seats a worker for it; for a ticket, claims the ticket for that
   * execution before the worker sits down, and gives both back if it can't (a 409 from the gate included).
   */
  private async seatCard(card: Pick<OporaCard, 'id' | 'name' | 'group' | 'sectorName'> & { department?: string }, by: string, owner?: string, ticket?: { ticket: WorkerTicket; scope: GateScope }): Promise<string | undefined> {
    const { project, workspace } = this.state;
    if (!project || !workspace) return 'Opora isn’t linked to this floor';
    if (this.runs.some((r) => r.cardId === card.id && r.state !== 'gone')) return `The office is already on “${card.name}”`;
    const freeDesk = () => deskFor(card.group, card.department ?? card.sectorName, this.floor.desks(), this.floor.labels(), (d) => this.floor.deskOccupied(d));
    const full = 'Every desk is taken: send someone home, or build the back office out';
    if (!freeDesk()) return full;
    if (!this.floor.stop) return 'Office cannot enforce Canvas execution deadlines';
    let bound = false;
    const forTicket = ticket && {
      body: ticket.ticket.body,
      bind: async (executionId: string) => { await this.gate.claim(ticket.scope, ticket.ticket.ticketId, executionId); bound = true; },
    };
    let dispatched;
    try {
      dispatched = await this.executions.dispatch({ project: project.id, workspace, nodeId: card.id },
        () => this.events.prepareTask?.(project.id, workspace, card.id, owner) ?? Promise.resolve(''),
        // The desk is picked when the worker sits down, so tickets in quick succession don't all pick the same one.
        (prompt, cardModel) => seatForOpora(() => { const desk = freeDesk(); return desk ? this.floor.seat(desk, by, prompt, owner, cardModel) : full; }), prompt => withReaBrief(prompt, this.events.prompt),
        () => prepareDesignBrief({ client: this.client, prompt: this.events.prompt, card, base: this.state.url, project: project.id, workspace, repoDir: this.floor.dir, dataDir: this.dataDir, log: m => console.warn(`[opora] ${m}`) }),
        this.floor.prepareWorker ? async () => {
          const desk = freeDesk(); if (!desk) throw new Error(full);
          const worker = await this.floor.prepareWorker!(desk, by, owner);
          return { ...worker, start: (prompt: string, cardModel?: CardModel) => seatForOpora(() => worker.start(prompt, cardModel)) };
        } : undefined, forTicket);
    } catch (error) {
      // The execution went back in dispatch; a ticket claimed for it goes back to the heart's queue too.
      if (ticket && bound) await this.gate.release(ticket.scope, ticket.ticket.ticketId).catch(() => {});
      if (ticket) this.gate.forget(ticket.scope, ticket.ticket.ticketId);
      return (error as Error).message;
    }
    const seated = dispatched.worker;
    this.runs.unshift({
      cardId: card.id,
      cardName: card.name,
      ...(card.sectorName ? { sectorName: card.sectorName } : {}),
      group: card.group,
      workerId: seated.id,
      workerName: seated.name,
      deskId: seated.deskId,
      ...(seated.worktree ? { branch: seated.worktree.branch, worktreeBase: seated.worktree.base } : {}),
      by,
      startedAt: Date.now(),
      state: 'working',
      leaseUntil: new Date(dispatched.execution.expiresAt * 1000).toISOString(),
      workspace,
      execution: dispatched.execution,
      deadlineUnixMs: dispatched.deadlineUnixMs,
      ...(ticket ? { ticketId: ticket.ticket.ticketId } : {}),
    });
    this.changed();
    this.events.toast(`🛰️ ${seated.name} took “${card.name}” from the Opora canvas${ticket ? ' (OPORA ticket)' : ''}${card.group === 'design' ? ' (design)' : ''}`, 'info');
    return undefined;
  }

  /**
   * Asks the gate for the next ticket (in the lobby session, which never takes one) and works on it while
   * there's room: under `maxRuns` and a desk free, both checked before anything is claimed. No ticket, no work.
   */
  private async nextTicket() {
    const scope = this.state.connected ? this.linkedScope() : undefined;
    if (!scope || this.runs.filter((r) => r.state !== 'gone').length >= this.state.maxRuns) return;
    let ticket: WorkerTicket | null;
    try { ticket = (await this.gate.request(scope)).ticket; } catch (error) { return this.sayOnce('gate', `🎫 OPORA's gate gives no ticket: ${(error as Error).message}`); }
    this.ticketSaid.delete('gate');
    if (!ticket || this.runs.some((r) => r.ticketId === ticket.ticketId && r.state !== 'gone')) return;
    const card = ticketCard(ticket, this.state.cards.find((c) => c.id === ticket.machine.cardId));
    // A ticket the office can't seat now stays issued, unclaimed, for a later poll.
    if (!deskFor(card.group, card.department ?? card.sectorName, this.floor.desks(), this.floor.labels(), (d) => this.floor.deskOccupied(d))) return;
    const orchestrator = this.floor.orchestrator?.();
    const err = await this.seatCard(card, orchestrator?.by ?? '🫀 OPORA', orchestrator?.owner, { ticket, scope });
    if (err) this.sayOnce(ticket.ticketId, `🎫 OPORA ticket for “${card.name}” wasn't taken: ${err}`);
  }

  /** For each run on a ticket: the worker's queued feedback to the gate, and the heart's answers back to the worker. */
  private async tendTickets() {
    const directory = path.join(this.dataDir, 'opora-executions');
    for (const run of this.runs) {
      if (!run.ticketId || run.state === 'gone' || run.ticketDelivered || !run.execution) continue;
      const scope = { project: run.execution.project, workspace: run.execution.workspace };
      try {
        for (const item of pendingFeedback(directory, run.execution.executionId, run.ticketFeedbackSent ?? 0)) {
          if (item.text.trim()) await this.gate.feedback(scope, run.ticketId, item.kind, item.text);
          run.ticketFeedbackSent = (run.ticketFeedbackSent ?? 0) + 1;
        }
        const { ticket } = await this.gate.request(scope, run.ticketId);
        if (ticket?.ticketId === run.ticketId) writeNotes(directory, run.execution.executionId, ticket.feedback);
      } catch (error) {
        if (error instanceof GateError && error.code === 'ticket_not_held') { this.ticketLost(run); continue; }
        this.sayOnce(`tend:${run.ticketId}`, `🎫 OPORA ticket of “${run.cardName}”: ${(error as Error).message}`);
      }
    }
  }

  /** After the hand-off: the ticket is delivered with the result's summary and the pull request's head. */
  private async deliverTicket(run: Held, out: { state: string; headSha?: string } | undefined) {
    if (!out || !run.ticketId || run.ticketDelivered || !run.execution || this.delivering.has(run.ticketId)) return;
    const result = this.executions.pullRequests.reported(run.execution.executionId);
    if (!result) return;
    const summary = typeof result.summary === 'string' && result.summary.trim() ? result.summary.trim().slice(0, 4000) : `Work on “${run.cardName}” handed off`;
    const scope = { project: run.execution.project, workspace: run.execution.workspace };
    this.delivering.add(run.ticketId);
    try {
      await this.gate.deliver(scope, run.ticketId, summary, out.headSha);
      run.ticketDelivered = true;
      this.gate.forget(scope, run.ticketId);
      this.persist();
    } catch (error) {
      if (error instanceof GateError && error.code === 'ticket_not_held') return this.ticketLost(run);
      // An open question is a 409 ticket_state: it's delivered at a later hand-off, once the heart answered.
      const why = error instanceof GateError && error.code === 'ticket_state' ? 'it waits for the heart’s answer to a question' : (error as Error).message;
      this.sayOnce(`deliver:${run.ticketId}`, `🎫 OPORA ticket of “${run.cardName}” isn't delivered yet: ${why}`);
    } finally {
      this.delivering.delete(run.ticketId);
    }
  }

  /**
   * OPORA gave the run's ticket to another holder (its new session's `ticket.claim` came back `ticket_not_held`):
   * the run ends cleanly, its worker sent home and its execution let go, with no hand-off and no delivery.
   */
  private ticketLost(run: Held) {
    if (!run.ticketId || !run.execution || run.state === 'gone') return;
    this.gate.forget({ project: run.execution.project, workspace: run.execution.workspace }, run.ticketId);
    const reason = `OPORA ticket of “${run.cardName}” is held by another worker now`;
    if (run.workerId) requestExecutionStop(run, run.workerId, reason, this.floor.stop?.bind(this.floor), () => this.changed(), (m) => this.sayOnce(`lost:${run.ticketId}`, `🎫 ${m}`));
    run.state = 'gone';
    void this.executions.release(run).then(() => this.persist());
  }

  /** How many tickets the floor works on at once, as set in the 🛰️ Opora window; kept with the floor's Opora state. */
  setMaxRuns(n: number): string | undefined {
    if (!Number.isInteger(n) || n < 1 || n > OPORA_LIMITS.maxRuns) return `Between 1 and ${OPORA_LIMITS.maxRuns} tickets at once`;
    this.state.maxRuns = n;
    this.changed();
    return undefined;
  }

  private sayOnce(key: string, text: string) {
    if (this.ticketSaid.has(key)) return;
    this.ticketSaid.add(key);
    console.warn(`[opora] ${text}`);
    this.events.toast(text, 'warn');
  }

  onWorker(info: WorkerInfo) {
    const run = this.runs.find((r) => r.workerId === info.id && r.state !== 'gone');
    if (!run) return;
    this.handOff(run, info);
    this.executions.onWorker(info);
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
    this.executions.controller.shutdown();
    this.reviews?.shutdown();
    this.upkeep?.shutdown();
    this.live.stop();
    this.persist();
  }

  private async read() {
    const s = this.state;
    try {
      await this.client.health();
    } catch (err) {
      Object.assign(s, { connected: false, embeddable: false, embedOrigins: undefined, error: (err as Error).message, project: null, linkedBy: undefined, projects: [], workspace: null, workspaces: [], workspaceBy: undefined, followHeart: undefined, sectors: [], cards: [], humanWait: undefined, heart: undefined, scope: [], checkedAt: Date.now() });
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
        Object.assign(s, { connected: true, error: lost ?? `No Opora project plans this floor's folder (${this.floor.dir}): pick one in the 🛰️ Opora window, or add the folder in Opora as a local or git project`, project: null, linkedBy: undefined, workspace: null, workspaces: [], workspaceBy: undefined, followHeart: undefined, sectors: [], cards: [], humanWait: undefined, heart: undefined, scope: [], checkedAt: Date.now() });
        return;
      }
      // The workspace someone picked while it's still there, else `main`, else the first; a picked one that's gone says so.
      const workspaces = await this.client.workspaces(project.id);
      const picked = this.chosenWorkspace ? workspaces.find((w) => w.id === this.chosenWorkspace) : undefined;
      // Planned by OPORA's heart: it makes its own workspaces, and the floor follows the one of its last plan unless a person pinned another.
      // Unread, the last answer for the same project stands.
      const heartRead = await this.client.heartState(project.id).catch(() => (s.project?.id === project.id ? { on: s.heart === true, activeWorkspace: this.heartWorkspace ?? null } : { on: false, activeWorkspace: null }));
      s.heart = heartRead.on;
      this.heartWorkspace = heartRead.activeWorkspace ?? undefined;
      const followed = !this.chosenWorkspace && heartRead.on && heartRead.activeWorkspace ? workspaces.find((w) => w.id === heartRead.activeWorkspace) : undefined;
      const workspace = picked?.id ?? followed?.id ?? (workspaces.some((w) => w.id === 'main') ? 'main' : (workspaces[0]?.id ?? 'draft'));
      const gone = this.chosenWorkspace && !picked ? `The workspace this floor was set to (${this.chosenWorkspace}) isn't in ${project.name} on Opora any more: reading ${workspaces.find((w) => w.id === workspace)?.label ?? workspace} instead, or pick another` : undefined;
      // Another project (its folder's, as the one picked left Opora) has another architecture: the whole of it.
      if (s.project && s.project.id !== project.id) this.focus = [];
      const nodes = await this.client.nodes(project.id, workspace);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const isCard = (id: string) => byId.get(id)?.kind === 'node';
      const sectors = nodes.filter((n) => n.kind === 'sector').slice(0, MAX_SECTORS);
      // The cards Canvas offers a ready claim for (agent-state.ts), each in the sector it's laid out in; the same read
      // says what waits on a person. The office takes work only as tickets (nextTicket); these are shown, not taken.
      const agent = await this.client.agentState(project.id, workspace).catch(() => null);
      const sectorOf = (id: string) => { for (let n = byId.get(id); n; n = n.parentId ? byId.get(n.parentId) : undefined) if (n.kind === 'sector') return n; return undefined; };
      const cards: OporaCard[] = agent ? [...agent.ready].filter(isCard).map((id) => {
        const sector = sectorOf(id);
        return { id, name: byId.get(id)?.name?.trim().slice(0, 200) || 'Card', status: 'frontier' as const, group: cardGroup(undefined), ready: true,
          ...(sector ? { sectorId: sector.id, sectorName: sector.name } : {}), ...(agent.runs.get(id) ? { run: agent.runs.get(id) } : {}) };
      }) : [];
      s.humanWait = agent?.humanWait;
      const scope = buildScope(nodes);
      const placed = placeCards(scope, nodes, cards.map((c) => c.id));
      for (const c of cards) {
        const at = placed.get(c.id);
        if (at === null) c.unplaced = true;
        else if (at && at !== c.id) c.placedIn = at;
      }
      // Heads Canvas still has no self-check evidence for: run the checks again, for real (self-check-requests.ts).
      if (agent?.selfChecks.length && this.selfChecks) runRequestedSelfChecks(this.selfChecks, gitRunner(), this.floor.dir, this.dataDir, { project: project.id, workspace }, agent.selfChecks);
      Object.assign(s, { connected: true, error: [lost, gone, this.focusLost()].filter(Boolean).join(' · ') || undefined, project: { id: project.id, name: project.name }, linkedBy: chosen ? 'choice' : 'folder', workspace, workspaces, workspaceBy: picked ? 'choice' : followed ? 'heart' : 'default', followHeart: !!followed, sectors: sectors.map((x) => ({ id: x.id, name: x.name })), cards, scope, checkedAt: Date.now() });
    } catch (err) {
      Object.assign(s, { connected: true, error: (err as Error).message, checkedAt: Date.now() });
    }
  }

  /** Pushes the work of a run whose worker reported its result and opens its pull request (pull-request-handoff.ts). */
  private handOff(run: Held, info: WorkerInfo | undefined) {
    const handoff = this.executions.handOff(run, info, this.floor.dir, (message, level) => {
      (level === 'info' ? console.log : console.warn)(`[opora] ${message}`);
      this.events.toast(message, level);
    });
    // Then the run's ticket is delivered (ticket-gate.ts); the execution's own result is already in.
    return handoff?.then(async (out) => { await this.deliverTicket(run, out); return out; });
  }

  private async letGo(run: Held) {
    await this.handOff(run, undefined);
    await this.executions.release(run);
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
      writeFileSync(this.statePath, JSON.stringify({ runs: this.runs, maxRuns: this.state.maxRuns, linkedTo: this.chosen, workspace: this.chosenWorkspace, focus: this.focus }, null, 2), { mode: 0o600 });
    } catch {
      // a full disk loses the bridge's state, not the office
    }
  }

  private restore() {
    try {
      if (!existsSync(this.statePath)) return;
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { runs?: Held[]; maxRuns?: number; linkedTo?: string; workspace?: string; focus?: unknown };
      if (Array.isArray(saved.runs)) this.runs = saved.runs.filter((r) => r && typeof r.cardId === 'string');
      for (const r of this.runs) if (r.state !== 'gone' && r.workerId) markForOpora(r.workerId);
      // A ticket held before the restart: the gate's next session for it claims it again for the same execution.
      for (const r of this.runs) if (r.state !== 'gone' && r.ticketId && !r.ticketDelivered && r.execution) this.gate.hold({ project: r.execution.project, workspace: r.execution.workspace }, r.ticketId, r.execution.executionId);
      if (typeof saved.maxRuns === 'number') this.state.maxRuns = Math.max(1, Math.min(OPORA_LIMITS.maxRuns, saved.maxRuns));
      this.chosen = typeof saved.linkedTo === 'string' && saved.linkedTo ? saved.linkedTo : undefined;
      this.chosenWorkspace = typeof saved.workspace === 'string' && saved.workspace ? saved.workspace : undefined;
      this.focus = Array.isArray(saved.focus) ? saved.focus.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      // a broken file starts the bridge afresh
    }
  }
}

/**
 * The card a ticket is for, as the office seats it: its department (desks signed so) and its profile (the
 * design pipeline's desks or the developers') from the ticket's `machine` when the heart set them, else what
 * the canvas read says, else a developer's card.
 */
export function ticketCard(ticket: WorkerTicket, known?: Pick<OporaCard, 'name' | 'group' | 'sectorName'>) {
  const { cardId, department, profile } = ticket.machine;
  return { id: cardId, name: known?.name ?? ticket.body.essence?.split('\n')[0]?.slice(0, 200) ?? 'Ticket',
    group: profile ? cardGroup(profile) : (known?.group ?? cardGroup(undefined)),
    ...(known?.sectorName ? { sectorName: known.sectorName } : {}), ...(department ? { department } : {}) };
}
