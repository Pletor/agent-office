// The orchestrator's focused card on a floor: the card someone picked at the Opora Control Center's right
// board, kept across restarts, with the overview of it (brief.ts) put together from the reads the office
// already makes of Opora (PR Lens, area and project plan, a design card's preview). The planner at the
// table gets the overview with its brief (planning.ts), and it's kept in a file the planner can re-read.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LENS_ID } from '../../shared/opora-lens.js';
import { focusPaths } from '../../shared/opora-scope.js';
import type { OporaState, OrchestratorFocus, OrchestratorState } from '../../shared/protocol.js';
import { lensReader, type LensReader } from '../opora/lens-reader.js';
import { previewReader, type PreviewReader } from '../opora/preview-reader.js';
import { layersReader, type LayersReader } from '../opora/layers-reader.js';
import { orchestratorBrief } from './brief.js';
import { cardPath } from './page-brief.js';

/** How often the overview is put together again while a card is focused (the readers cache for 30 s). */
const REFRESH_MS = 60_000;
/** Where the overview is kept for the planner, under the floor's `.agent-office`. */
export const BRIEF_FILE = 'orchestrator-focus.md';

export interface FocusDeps {
  /** The floor's link to Opora as it is now (OporaBridge.view). */
  opora(): OporaState;
  /** Who the office reads Opora as (`office-<floor>`). */
  agent: string;
  dataDir: string;
  update(state: OrchestratorState): void;
  lens?: Pick<LensReader, 'card' | 'plan'>;
  preview?: Pick<PreviewReader, 'card'>;
  layers?: Pick<LayersReader, 'page'>;
}

export class OrchestratorFocusKeeper {
  private focus: OrchestratorFocus | null = null;
  /** The Opora project the focused card is in: a floor linked to another one lets the card go. */
  private project?: string;
  private text: string | null = null;
  private at?: number;
  private timer: NodeJS.Timeout;
  private seq = 0;

  constructor(private deps: FocusDeps) {
    this.restore();
    // No card picked: an overview left from before (of whatever project) isn't the planner's.
    if (!this.focus) this.writeFile();
    this.timer = setInterval(() => { if (this.focus) void this.refresh(); }, REFRESH_MS);
    this.timer.unref?.();
    // After a restart, once the bridge has had a moment to read the canvas.
    if (this.focus) setTimeout(() => void this.refresh(), 5000).unref?.();
  }

  state(): OrchestratorState {
    return { focus: this.focus ? { ...this.focus } : null, brief: this.text, ...(this.at ? { briefAt: this.at } : {}) };
  }

  /** Picks the card for the orchestrator (or, null, lets go). Returns why not, or nothing. */
  set(cardId: string | null, by: string): string | undefined {
    if (cardId === null) {
      if (!this.focus) return undefined;
      this.focus = null;
      this.project = undefined;
      this.text = null;
      this.at = undefined;
      this.seq++;
      this.persist();
      this.deps.update(this.state());
      return undefined;
    }
    if (typeof cardId !== 'string' || !LENS_ID.test(cardId)) return 'That isn’t a card';
    const o = this.deps.opora();
    // A page or subpage of the switchboard's cascade is a card even before the frontier lists it.
    const card = o.cards.find((c) => c.id === cardId) ?? o.scope.find((n) => n.id === cardId && (n.level === 'page' || n.level === 'subpage'));
    if (!card) return 'That card isn’t on the floor’s Opora canvas';
    this.focus = { cardId, name: card.name.slice(0, 160), by: by.slice(0, 60), at: Date.now() };
    this.project = o.project?.id;
    this.text = null;
    this.at = undefined;
    this.persist();
    this.deps.update(this.state());
    void this.refresh();
    return undefined;
  }

  /**
   * Follows the cell's focus at the 🎚️ switchboard: its deepest page or subpage switched on (the first
   * focus's) is the orchestrator's card, and a focus with none (a domain, the whole project) lets go.
   * Called after someone switches the focus; a card picked in between stays until the next switch.
   */
  follow(by: string): string | undefined {
    const o = this.deps.opora();
    const leaf = focusPaths(o.scope, o.focus)[0]?.at(-1);
    const id = leaf && (leaf.level === 'page' || leaf.level === 'subpage') ? leaf.id : null;
    if (id === (this.focus?.cardId ?? null)) return undefined;
    return this.set(id, by);
  }

  /**
   * The floor was linked to another Opora project (OporaBridge.link): the card picked in the old one,
   * and its overview (that project's plan), aren't the planner's any more.
   */
  relinked(): void {
    this.set(null, '');
  }

  /** The overview for the planner's brief, once it's been put together (never one of a project the floor left). */
  brief(): string | undefined {
    if (this.leftProject()) {
      this.relinked();
      return undefined;
    }
    return this.text ?? undefined;
  }

  /** The focused card is of a project the floor is no longer linked to (a focus kept from before this was tracked counts as the linked one's). */
  private leftProject(): boolean {
    if (!this.focus || !this.project) return false;
    const now = this.deps.opora().project?.id;
    return !!now && now !== this.project;
  }

  /** Reads the card's Lens (and a design card's preview) through the office's cached readers, and puts the overview together. */
  async refresh(): Promise<void> {
    if (this.leftProject()) return this.relinked();
    const focus = this.focus;
    if (!focus) return;
    const seq = ++this.seq;
    const o = this.deps.opora();
    // A focus kept from before its project was noted belongs to the project linked now.
    this.project ??= o.project?.id;
    const card = o.cards.find((c) => c.id === focus.cardId);
    const run = o.runs.find((r) => r.cardId === focus.cardId && r.state !== 'gone');
    const linked = o.project && o.workspace ? { base: o.url, project: o.project.id, workspace: o.workspace } : undefined;
    const design = !!card && (card.group === 'design' || card.profile === 'design');
    const lens = this.deps.lens ?? lensReader, preview = this.deps.preview ?? previewReader, layers = this.deps.layers ?? layersReader;
    const page = linked ? await layers.page({ base: linked.base, agent: this.deps.agent, project: linked.project, workspace: linked.workspace }, focus.cardId).catch(() => undefined) : undefined;
    const [cardLens, areaPlan, projectPlan, shown] = linked
      ? await Promise.all([
        lens.card(linked.base, this.deps.agent, linked.project, linked.workspace, focus.cardId),
        card?.sectorId && LENS_ID.test(card.sectorId) ? lens.plan(linked.base, this.deps.agent, linked.project, linked.workspace, card.sectorId) : Promise.resolve(undefined),
        lens.plan(linked.base, this.deps.agent, linked.project, linked.workspace),
        design ? preview.card({ base: linked.base, agent: this.deps.agent, project: linked.project, workspace: linked.workspace }, focus.cardId) : Promise.resolve(undefined),
      ]).catch(() => [undefined, undefined, undefined, undefined] as const)
      : [undefined, undefined, undefined, undefined];
    // Someone picked another card (or let go) while this was being read.
    if (seq !== this.seq || this.focus !== focus) return;
    const text = orchestratorBrief({ focus, card, run, path: cardPath(o.scope, focus.cardId) || undefined, page, lens: cardLens, areaPlan, projectPlan, preview: shown ?? (design ? { state: 'unavailable', mode: 'brand', sketch: false, heads: [] } : undefined) });
    if (text === this.text) return;
    this.text = text;
    this.at = Date.now();
    this.writeFile();
    this.deps.update(this.state());
  }

  shutdown() {
    clearInterval(this.timer);
  }

  private get statePath() { return path.join(this.deps.dataDir, 'orchestrator.json'); }

  private writeFile() {
    const file = path.join(this.deps.dataDir, BRIEF_FILE);
    try {
      if (this.text) writeFileSync(file, `${this.text}\n`, { mode: 0o600 });
      else rmSync(file, { force: true });
    } catch {
      // the planner still gets the overview in its brief
    }
  }

  private persist() {
    try {
      writeFileSync(this.statePath, JSON.stringify({ focus: this.focus, ...(this.focus && this.project ? { project: this.project } : {}) }), { mode: 0o600 });
    } catch {
      // a full disk forgets the focus, not the office
    }
    if (!this.focus) this.writeFile();
  }

  private restore() {
    try {
      if (!existsSync(this.statePath)) return;
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { focus?: Partial<OrchestratorFocus> | null; project?: unknown };
      const f = saved.focus;
      if (f && typeof f.cardId === 'string' && LENS_ID.test(f.cardId) && typeof f.name === 'string' && typeof f.by === 'string' && typeof f.at === 'number') {
        this.focus = { cardId: f.cardId, name: f.name.slice(0, 160), by: f.by.slice(0, 60), at: f.at };
        if (typeof saved.project === 'string' && saved.project) this.project = saved.project;
      }
    } catch {
      // a broken file starts with no focus
    }
  }
}
