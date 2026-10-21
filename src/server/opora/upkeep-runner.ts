import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo } from '../../shared/floors.js';
import { childEnv } from '../workers/env.js';
import { resolveCommand } from '../workers/process.js';
import { claudeResolver } from './conflict-resolver.js';
import { MergeGuard, type GuardOutcome } from './merge-guard.js';
import { PrUpkeep, type UpkeepOutcome } from './pr-upkeep.js';
import { upkeepConfig, type UpkeepConfig } from './upkeep-config.js';
import { UpkeepLedger, checkRunner, ghRunner, gitRunner, type Say, type UpkeepTools } from './upkeep-tools.js';

/**
 * Runs PR upkeep (pr-upkeep.ts) and the post-merge guard (merge-guard.ts) for one floor's
 * repository, on a timer of its own, one pass at a time. Each pass first checks the floor has a
 * GitHub `origin` and that gh is signed in, and skips cleanly (saying so once) when not. Everything it
 * does is a server log line, a toast and a line in `opora-upkeep/events.jsonl`.
 */

export interface UpkeepPass { upkeep?: UpkeepOutcome[]; guard?: GuardOutcome; skipped?: string }

export class OporaUpkeep {
  private upkeep: PrUpkeep;
  private guard: MergeGuard;
  private running?: Promise<UpkeepPass>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private lastSkip = '';

  constructor(private config: UpkeepConfig, private repo: string, private root: string, private tools: UpkeepTools,
    private say: Say, ledger = new UpkeepLedger(path.join(root, 'state.json')), now: () => number = Date.now) {
    this.upkeep = new PrUpkeep(config, tools, ledger, say, now);
    this.guard = new MergeGuard(config, tools, ledger, say);
  }

  /** One pass; a pass under way is joined, not doubled. */
  tick(): Promise<UpkeepPass> {
    if (this.stopped || (!this.config.upkeep && !this.config.guard)) return Promise.resolve({ skipped: 'off' });
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  start(firstMs = 60_000) {
    const next = (ms: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.tick().catch(() => undefined).finally(() => next(this.config.intervalMs)), ms);
      this.timer.unref?.();
    };
    next(firstMs);
  }

  shutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async pass(): Promise<UpkeepPass> {
    const repository = normalizeRepo((await this.tools.git(['remote', 'get-url', 'origin'], this.repo).catch(() => '')).trim());
    if (!repository) return this.skip('the floor has no GitHub remote (origin)');
    try { await this.tools.gh(['auth', 'status'], this.repo); } catch { return this.skip("gh isn't signed in to GitHub on the office's machine"); }
    this.lastSkip = '';
    const trees = path.join(this.root, 'trees');
    const result: UpkeepPass = {};
    if (this.config.upkeep) {
      try { result.upkeep = await this.upkeep.pass(repository, this.repo, trees); } catch (e) { this.say(`🛰️ PR upkeep pass failed: ${(e as Error).message}`, 'warn'); }
    }
    if (this.config.guard) {
      try { result.guard = await this.guard.pass(repository, this.repo, trees); } catch (e) { this.say(`🛡️ Post-merge guard pass failed: ${(e as Error).message}`, 'warn'); }
    }
    return result;
  }

  private skip(reason: string): UpkeepPass {
    if (this.lastSkip !== reason) this.say(`🛰️ Opora upkeep skipped: ${reason}`, 'info');
    this.lastSkip = reason;
    return { skipped: reason };
  }
}

/** The floor's upkeep, started, while `AGENT_OFFICE_OPORA_UPKEEP` or `AGENT_OFFICE_OPORA_GUARD` is on; else undefined. */
export function createOporaUpkeep(repo: string, dataDir: string, toast: Say, env: NodeJS.ProcessEnv = process.env): OporaUpkeep | undefined {
  const config = upkeepConfig(env);
  if (!config.upkeep && !config.guard) return undefined;
  const root = path.join(dataDir, 'opora-upkeep');
  const say: Say = (message, level) => {
    (level === 'info' ? console.log : console.warn)(`[opora] ${message}`);
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), level, message })}\n`, { mode: 0o600 });
    } catch { /* the log line and the toast still say it */ }
    toast(message, level);
  };
  const claude = config.upkeep && config.resolve ? resolveCommand('claude') : null;
  if (config.upkeep && config.resolve && !claude) say('🛰️ The claude CLI is not installed: PR upkeep leaves textual conflicts to a human', 'warn');
  if (config.upkeep && !config.checkCommand) say('🛰️ AGENT_OFFICE_OPORA_CHECK_COMMAND is not set: PR upkeep pushes nothing until it is', 'warn');
  const upkeep = new OporaUpkeep({ ...config, resolve: config.resolve && !!claude }, repo, root, {
    git: gitRunner(),
    gh: ghRunner,
    check: checkRunner(config.checkTimeoutMs),
    resolve: claude ? claudeResolver(claude, childEnv(), config.resolveTimeoutMs, config.model) : () => Promise.reject(new Error('no claude CLI')),
  }, say);
  upkeep.start();
  return upkeep;
}
