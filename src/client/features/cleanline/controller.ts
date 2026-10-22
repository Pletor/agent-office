import type { CleanLine, RepoChoice } from '../../../shared/cleanline';

export interface LineView {
  loading: boolean;
  data?: CleanLine;
  error?: string;
}

/**
 * The board's data for the floor you're on and the repository picked (the floor's, or the office's
 * own). A change of floor or repository drops the old read; listeners hear only real changes.
 */
export class LineController {
  view: LineView = { loading: false };
  floor: string | null = null;
  repo: RepoChoice = 'floor';
  private request?: AbortController;
  private sig = '';
  private listeners = new Set<() => void>();

  constructor(private read: (floor: string, repo: RepoChoice, force: boolean, signal: AbortSignal) => Promise<CleanLine>) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  setScope(floor: string | null, repo: RepoChoice = this.repo) {
    if (floor === this.floor && repo === this.repo) return;
    this.floor = floor;
    this.repo = repo;
    this.request?.abort();
    this.request = undefined;
    this.view = floor ? { loading: true } : { loading: false, error: 'Nejprve vstup do patra kanceláře.' };
    this.emit();
    if (floor) void this.refresh();
  }

  async refresh(force = false) {
    if (this.request || !this.floor) return;
    const { floor, repo } = this;
    const request = new AbortController();
    this.request = request;
    try {
      const data = await this.read(floor, repo, force, request.signal);
      if (floor === this.floor && repo === this.repo && !request.signal.aborted) this.view = { loading: false, data };
    } catch (error) {
      if (floor === this.floor && repo === this.repo && !request.signal.aborted) this.view = { ...this.view, loading: false, error: `Linii nelze načíst: ${(error as Error).message}` };
    } finally {
      if (this.request === request) this.request = undefined;
      this.emit();
    }
  }

  /** Tells the listeners, unless nothing they'd draw changed (the time it was checked aside). */
  private emit() {
    const { data, ...rest } = this.view;
    const sig = JSON.stringify([rest, data ? { ...data, checkedAt: 0 } : null, this.repo]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.listeners.forEach((fn) => fn());
  }
}
