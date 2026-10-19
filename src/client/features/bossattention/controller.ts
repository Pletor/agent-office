import type { BossAttention } from '../../../shared/boss-attention';

export interface AttentionView {
  loading: boolean;
  data?: BossAttention;
  error?: string;
}

/** A scope change cancels old reads; an old project's questions must never appear on a new floor. */
export class AttentionController {
  view: AttentionView = { loading: true };
  private scope = '';
  private request?: AbortController;
  private listeners = new Set<() => void>();

  constructor(private read: (floor: string, signal: AbortSignal) => Promise<BossAttention>) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  setScope(floor: string | null, project: string | null, workspace: string | null) {
    const key = JSON.stringify([floor, project, workspace]);
    if (key === this.scope) return;
    this.scope = key;
    this.request?.abort();
    this.request = undefined;
    this.view = { loading: !!floor, ...(!floor ? { error: 'Nejprve vstup do patra kanceláře.' } : {}) };
    this.emit();
    if (floor) void this.refresh();
  }

  async refresh() {
    if (this.request) return;
    const [floor] = JSON.parse(this.scope || '[null]') as [string | null];
    if (!floor) return;
    const key = this.scope;
    const request = new AbortController();
    this.request = request;
    // While a new read is in flight, the last successful snapshot remains visibly dated.
    this.view = { ...this.view, loading: true };
    this.emit();
    try {
      const data = await this.read(floor, request.signal);
      if (key === this.scope && !request.signal.aborted) this.view = { loading: false, data };
    } catch (error) {
      if (key === this.scope && !request.signal.aborted) this.view = { loading: false, error: `Stav nelze ověřit: ${(error as Error).message}` };
    } finally {
      if (this.request === request) {
        this.request = undefined;
        this.emit();
      }
    }
  }

  private emit() { this.listeners.forEach((fn) => fn()); }
}
