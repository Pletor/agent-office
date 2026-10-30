// Claude Code's first-run "Quick safety check: is this a project you created or one you trust?" stops
// a fresh worker before it can take its prompt (default answer: "No, exit"). Claude keeps that answer
// in its global config, `<config>/.claude.json` → `projects[<folder>].hasTrustDialogAccepted`. A
// floor is a folder someone added to the building on purpose, and its worktrees and workspaces are
// folders the office made itself, so for exactly those the office records the answer before Claude
// starts, the way Claude writes it: read, change, write a temp file, rename over. Nothing else in the
// file changes, a folder outside the floor is never touched, and login screens are never answered.
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Claude's global config for a run with `env`: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigFile(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** How Claude names a folder in `projects`: the absolute path, with forward slashes on Windows. */
export function claudeProjectKey(dir: string): string {
  return path.resolve(dir).replace(/\\/g, '/');
}

/** The command is Claude Code's own CLI (`claude`, `claude.exe`, `claude.cmd`, ...), the one that reads that config. */
export function isClaudeCommand(command: string): boolean {
  return /^claude(\.(exe|cmd|bat|ps1))?$/i.test(path.basename(command.trim()));
}

/** `dir` is the floor itself or inside it (a worktree or workspace the office made). */
export function insideFloor(floorDir: string, dir: string): boolean {
  const rel = path.relative(path.resolve(floorDir), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The folders of a run in `cwd` on the floor at `floorDir` whose trust the office may answer: none outside the floor. */
export function officeFolders(floorDir: string, cwd: string): string[] {
  if (!insideFloor(floorDir, cwd)) return [];
  return [...new Set([path.resolve(floorDir), path.resolve(cwd)])];
}

/** proper-lockfile's convention (a `<file>.lock` folder), which Claude uses around its own writes. */
const LOCK_STALE_MS = 10_000;
const LOCK_TRIES = 20;
const LOCK_WAIT_MS = 25;
const WRITE_TRIES = 3;

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Takes `<file>.lock`, waiting briefly while someone else holds it; a stale one is ignored. Says whether it's ours. */
function lock(file: string): boolean {
  const dir = `${file}.lock`;
  for (let i = 0; i < LOCK_TRIES; i++) {
    try {
      mkdirSync(dir);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) return false;
      } catch {
        continue; // released meanwhile
      }
      pause(LOCK_WAIT_MS);
    }
  }
  return false;
}

export interface TrustResult {
  /** Keys newly marked trusted. */
  added: string[];
  /** Why nothing could be written, if so. */
  error?: string;
}

/**
 * Marks `dirs` trusted in Claude's config at `file`. Only a config Claude already wrote is changed (a
 * missing or unreadable one is left for Claude's own first run, quietly when it's missing). A write that would overwrite a
 * change made meanwhile is retried on the fresh file.
 */
export function trustClaudeFolders(file: string, dirs: string[]): TrustResult {
  if (!dirs.length) return { added: [] };
  const keys = [...new Set(dirs.map(claudeProjectKey))];
  const held = lock(file);
  try {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
      let text: string;
      let config: any;
      try {
        text = readFileSync(file, 'utf8');
        config = JSON.parse(text);
      } catch (err) {
        // Claude never ran with this config: its own first run asks everything anyway.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { added: [] };
        return { added: [], error: `couldn't read ${file}: ${(err as Error).message}` };
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) return { added: [], error: `${file} isn't a JSON object` };
      if (config.projects !== undefined && (typeof config.projects !== 'object' || config.projects === null || Array.isArray(config.projects))) {
        return { added: [], error: `${file} has projects of an unexpected shape` };
      }
      const projects = (config.projects ??= {});
      const added = keys.filter((k) => projects[k]?.hasTrustDialogAccepted !== true);
      if (!added.length) return { added };
      for (const k of added) projects[k] = { ...(projects[k] && typeof projects[k] === 'object' ? projects[k] : {}), hasTrustDialogAccepted: true };
      const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
      let mode = 0o600;
      try {
        mode = statSync(file).mode & 0o777;
      } catch {
        // keep the default
      }
      try {
        writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
        // Someone wrote it meanwhile: ours would undo that, so start over from theirs.
        if (readFileSync(file, 'utf8') !== text) {
          unlinkSync(tmp);
          continue;
        }
        renameSync(tmp, file);
        return { added };
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          // never written
        }
        return { added: [], error: `couldn't write ${file}: ${(err as Error).message}` };
      }
    }
    return { added: [], error: `${file} kept changing` };
  } finally {
    if (held) {
      try {
        rmdirSync(`${file}.lock`);
      } catch {
        // gone already
      }
    }
  }
}
