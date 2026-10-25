// Waiting for a worktree to go quiet before self-checks run in it. A result ends the run's authority,
// which stops its worker, and the hand-off pushes and runs the checks right after: on Windows the
// stopped worker's node and python processes (a test watcher, a dev server, pytest) can still hold
// files in the worktree for a few seconds, and `npm ci` or the tests then fail for reasons that have
// nothing to do with the commit (a false red that blocked a pull request once). So the checks wait
// until no worker of the floor still runs in that worktree and no process still works inside it.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

/** What still runs in `dir`, as short descriptions ("worker Ada", "pid 4242 node"); empty when nothing does. */
export type BusyProbe = (dir: string) => Promise<string[]>;

export interface QuietOptions {
  /** How often to look again. */
  everyMs?: number;
  /** The longest it waits; past that the checks run anyway (the retry of a red check is the second guard). */
  maxMs?: number;
  /** How long it waits after the worktree went quiet, for file handles to be let go. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export interface Quiet { waitedMs: number; timedOut: boolean; busy: string[] }

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** Waits until every probe finds nothing running in `dir` (or `maxMs` passed), then `settleMs` more. */
export async function waitForQuiet(dir: string, probes: BusyProbe[], o: QuietOptions = {}): Promise<Quiet> {
  const every = o.everyMs ?? 2000, max = o.maxMs ?? 120_000, settle = o.settleMs ?? 3000;
  const sleep = o.sleep ?? realSleep, now = o.now ?? Date.now;
  const start = now();
  let busy: string[] = [];
  for (;;) {
    busy = (await Promise.all(probes.map((p) => p(dir).catch(() => [] as string[])))).flat();
    if (!busy.length) break;
    if (now() - start >= max) return { waitedMs: now() - start, timedOut: true, busy };
    await sleep(every);
  }
  const waited = now() - start;
  // Something had to be waited for: give its handles a moment to go too.
  if (waited > 0 && settle > 0) await sleep(settle);
  return { waitedMs: now() - start, timedOut: false, busy: [] };
}

/** Whether `file` is `dir` or inside it, either slash, any case on Windows. */
export function inside(dir: string, file: string): boolean {
  const norm = (p: string) => { const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? n.toLowerCase() : n; };
  const d = norm(dir), f = norm(file);
  return f === d || f.startsWith(`${d}/`);
}

/** The floor's workers still running in `dir` (anything but exited or offline). */
export function workerProbe(list: () => { name: string; status: string; worktree?: { path: string } }[], floorDir: string): BusyProbe {
  return async (dir) => list()
    .filter((w) => w.worktree && w.status !== 'exited' && w.status !== 'offline' && inside(dir, path.join(floorDir, w.worktree.path)))
    .map((w) => `worker ${w.name}`);
}

/**
 * Processes still working inside `dir`, besides the office itself: on Linux the ones whose working
 * directory is in it (/proc), on Windows the ones whose command line names it (a worktree's own
 * node_modules or .venv). Best effort: a machine where it can't look reports nothing.
 */
export const processProbe: BusyProbe = async (dir) => {
  if (process.platform === 'win32') return windowsProcesses(dir);
  if (process.platform === 'linux') return linuxProcesses(dir);
  return [];
};

function linuxProcesses(dir: string): string[] {
  const out: string[] = [];
  let pids: string[] = [];
  try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return []; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      if (!inside(dir, readlinkSync(`/proc/${pid}/cwd`))) continue;
      const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      out.push(`pid ${pid} ${name}`);
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

function windowsProcesses(dir: string): Promise<string[]> {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const needle = path.resolve(dir).replace(/\//g, '\\').toLowerCase();
      const alt = needle.replace(/\\/g, '/');
      resolve(stdout.split(/\r?\n/).map((l) => l.split('\t')).filter(([pid, , cmd]) => {
        if (!pid || Number(pid) === process.pid || !cmd) return false;
        const c = cmd.toLowerCase();
        return c.includes(`${needle}\\`) || c.includes(`${alt}/`) || c.endsWith(needle) || c.includes(`${needle}"`) || c.includes(`${needle} `);
      }).map(([pid, name]) => `pid ${pid} ${name}`));
    });
  });
}
