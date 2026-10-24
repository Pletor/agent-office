import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SelfCheckScope, SelfChecks } from './self-checks.js';

/**
 * Self-check evidence the office computed but couldn't get to Canvas (it timed out or answered 5xx),
 * kept on disk per (execution, head) so it survives a restart and is posted again, byte for byte, on
 * the bridge's poll until Canvas records it. Never the checks again: Canvas takes the first record for
 * a head and refuses a different one (409), and a re-run's durations and output would differ.
 */
export interface PendingSelfCheck extends SelfCheckScope {
  executionId: string;
  selfChecks: SelfChecks;
  /** Posts tried so far, when the next may go (Unix ms), and when the evidence was computed. */
  attempts: number;
  nextAt: number;
  since: number;
}

/** First re-post after 20 s (the bridge's poll), doubling to at most 10 minutes; given up after a day. */
export const SELF_CHECK_BACKOFF = { firstMs: 20_000, maxMs: 10 * 60_000, giveUpMs: 24 * 3600_000 };

export function selfCheckDelay(attempts: number, backoff = SELF_CHECK_BACKOFF): number {
  return Math.min(backoff.maxMs, backoff.firstMs * 2 ** Math.max(0, Math.min(20, attempts - 1)));
}

export class PendingSelfChecks {
  constructor(readonly file: string) {}

  all(): Record<string, PendingSelfCheck> {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, PendingSelfCheck> : {};
    } catch { return {}; }
  }

  has(key: string): boolean { return key in this.all(); }

  /** Keeps `entry` for `key`, dropping the same execution's evidence for any other head (its head moved on). */
  put(key: string, entry: PendingSelfCheck) {
    const all = this.all();
    for (const [k, e] of Object.entries(all)) if (e.executionId === entry.executionId && k !== key) delete all[k];
    all[key] = entry;
    this.write(all);
  }

  /** Drops the evidence of `executionId` waiting for a head other than `headSha`; returns the keys dropped. */
  supersede(executionId: string, headSha: string): string[] {
    const all = this.all();
    const gone = Object.keys(all).filter((k) => all[k].executionId === executionId && all[k].selfChecks.headSha !== headSha);
    if (!gone.length) return gone;
    for (const k of gone) delete all[k];
    this.write(all);
    return gone;
  }

  drop(key: string) {
    const all = this.all();
    if (!(key in all)) return;
    delete all[key];
    this.write(all);
  }

  private write(all: Record<string, PendingSelfCheck>) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
    } catch { /* a full disk loses the re-post, not the office */ }
  }
}
