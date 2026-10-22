// Pushes a floor's process events to Opora (POST /api/oporahub/process-events), so Opora's Hub sees
// the office's work live too. Fire and forget: batches of up to 50, sent within 250 ms of the first,
// the same batch again after a failure (Opora takes an id it has seen as a no-op; a batch it refused for good, 422, is dropped), a bounded queue
// that drops the oldest, and quiet backoff while Opora has no such endpoint (asked again each minute).
// It never throws into the office and never makes anything wait.

import type { ProcessEvent } from '../../shared/protocol.js';
import { OporaClient, OporaError } from '../opora/client.js';

export const PUSH_BATCH = 50;
export const PUSH_DELAY_MS = 250;
export const PUSH_QUEUE = 2000;
/** While Opora answers 404 (no process endpoint yet): ask again this often. */
export const PUSH_REPROBE_MS = 60_000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

/** Sends one batch; rejects with an OporaError (status 404 for a missing endpoint) when it didn't go. */
export type PushSend = (base: string, events: ProcessEvent[]) => Promise<void>;

let rejectionLogged = false;
/** Opora refused some events for good (invalid, or a project it doesn't have): said once, never retried. */
function logRejected(base: string, why: string) {
  if (rejectionLogged) return;
  rejectionLogged = true;
  console.log(`agent-office: Opora at ${base} refused some process events (${why.slice(0, 200)}); they are dropped, not sent again`);
}

export const oporaSend: PushSend = async (base, events) => {
  const r = await new OporaClient(base, 'office-process').processEvents(events);
  const rejected = Array.isArray(r?.rejected) ? r.rejected : [];
  if (rejected.length) logRejected(base, String(rejected[0]?.error ?? 'rejected'));
};

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(t: unknown): void;
  now(): number;
}
const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
  now: () => Date.now(),
};

/** One Opora's queue of events to push. */
export class ProcessPush {
  private queue: ProcessEvent[] = [];
  private timer?: unknown;
  private sending = false;
  private failures = 0;
  /** Opora had no endpoint: nothing is sent before this. */
  private missingUntil = 0;
  /** How many events were dropped off a full queue. */
  dropped = 0;
  sent = 0;
  stopped = false;

  constructor(
    readonly base: string,
    private send: PushSend = oporaSend,
    private timers: Timers = realTimers,
    private max = PUSH_QUEUE,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Whether Opora seems not to take process events (it answered 404 lately). */
  get missing(): boolean {
    return this.timers.now() < this.missingUntil;
  }

  add(event: ProcessEvent) {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > this.max) {
      this.dropped += this.queue.length - this.max;
      this.queue.splice(0, this.queue.length - this.max);
    }
    this.schedule(PUSH_DELAY_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number) {
    if (this.timer !== undefined || this.sending || this.stopped || !this.queue.length) return;
    const wait = Math.max(ms, this.missingUntil - this.timers.now());
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  /** Sends what's queued, a batch at a time, until it's empty or a send fails. */
  async flush(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    let retry = PUSH_DELAY_MS;
    try {
      while (this.queue.length && !this.stopped) {
        if (this.missing) break;
        const batch = this.queue.slice(0, PUSH_BATCH);
        try {
          await this.send(this.base, batch);
        } catch (err) {
          // 422: Opora took none of the batch and never will (it says why per event): done with it, not retried.
          if (err instanceof OporaError && (err.status === 422 || err.status === 400)) {
            logRejected(this.base, err.message);
            const last = batch[batch.length - 1];
            this.queue.splice(0, this.queue.indexOf(last) + 1);
            this.failures = 0;
            continue;
          }
          if (err instanceof OporaError && (err.status === 404 || err.status === 405)) {
            this.missingUntil = this.timers.now() + PUSH_REPROBE_MS;
            retry = PUSH_REPROBE_MS;
          } else retry = BACKOFF_MS[Math.min(this.failures++, BACKOFF_MS.length - 1)];
          break;
        }
        // The cursor moves past the batch only once Opora took it; the queue may have dropped some of it meanwhile.
        const last = batch[batch.length - 1];
        const at = this.queue.indexOf(last);
        this.queue.splice(0, at >= 0 ? at + 1 : 0);
        this.sent += batch.length;
        this.failures = 0;
        this.missingUntil = 0;
      }
    } catch {
      /* never into the office */
    } finally {
      this.sending = false;
    }
    if (this.queue.length) this.schedule(retry);
  }
}

/** Every Opora the building's floors push to, by its address. */
export class ProcessPushers {
  private pushers = new Map<string, ProcessPush>();
  constructor(private make: (base: string) => ProcessPush = (base) => new ProcessPush(base)) {}

  /** Queues an event for Opora at `base`, when it belongs to an Opora project and workspace and is the office's or GitHub's (Opora refuses its own source). */
  add(base: string | undefined, event: ProcessEvent) {
    if (!base || !event.refs.project || !event.refs.workspace || (event.source !== 'office' && event.source !== 'github')) return;
    let p = this.pushers.get(base);
    if (!p) this.pushers.set(base, (p = this.make(base)));
    p.add(event);
  }

  stop() {
    for (const p of this.pushers.values()) p.stop();
    this.pushers.clear();
  }
}
