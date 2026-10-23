// Reading a worker's Claude Code transcript as it grows, for the third screen: only what was appended
// since the last read (complete lines), its subagents' transcripts beside it, and finding the file from
// the session id when no hook has named it yet (after the office restarted).

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySubagentLine, applyTranscriptLine, newTranscript, type SubagentTrail, type TranscriptState } from './transcript.js';

/** The most of a file one read takes in: a transcript met for the first time is read from its last 8 MB. */
const FIRST_READ = 8 * 1024 * 1024;
const CHUNK = 2 * 1024 * 1024;

/** Complete lines appended since `offset`; returns them and the new offset. A half-written last line waits. */
export function readAppended(file: string, offset: number): { lines: string[]; offset: number } {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { lines: [], offset };
  }
  try {
    const size = fstatSync(fd).size;
    if (size < offset) offset = 0; // not the file we knew
    let skipFirst = false;
    if (offset === 0 && size > FIRST_READ) {
      offset = size - FIRST_READ;
      skipFirst = true; // starts mid-line
    }
    const lines: string[] = [];
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.allocUnsafe(len);
      const got = readSync(fd, buf, 0, len, offset);
      if (got <= 0) break;
      const end = buf.lastIndexOf(10, got - 1);
      if (end < 0) break; // a line longer than the chunk, or the tail still being written
      const parts = buf.toString('utf8', 0, end).split('\n');
      if (skipFirst) { parts.shift(); skipFirst = false; }
      for (const p of parts) if (p.trim()) lines.push(p);
      offset += end + 1;
    }
    return { lines, offset };
  } finally {
    closeSync(fd);
  }
}

/** Where Claude Code keeps its projects' transcripts: the configured folder, and the home one. */
export function claudeProjectDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter((d): d is string => !!d).map((d) => path.join(d, 'projects'));
  return [...new Set(dirs)];
}

/** The transcript of session `id` under one of `roots`, if there's one. */
export function findTranscript(id: string, roots: string[]): string | undefined {
  if (!/^[\w-]{8,80}$/.test(id)) return undefined;
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const f = path.join(root, d, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
  }
  return undefined;
}

function parse(l: string): unknown {
  try {
    return JSON.parse(l);
  } catch {
    return undefined;
  }
}

/** One session's transcript and its subagents', read as they grow. */
export class TranscriptTracker {
  readonly state: TranscriptState = newTranscript();
  private offset = 0;
  private subs = new Map<string, { offset: number; toolUseId?: string; trail: SubagentTrail }>();

  constructor(readonly file: string) {}

  /** Reads what's new. True when anything was. */
  scan(): boolean {
    const r = readAppended(this.file, this.offset);
    this.offset = r.offset;
    for (const l of r.lines) applyTranscriptLine(this.state, parse(l));
    let changed = r.lines.length > 0;
    if (this.scanSubagents()) changed = true;
    return changed;
  }

  /** Subagent transcripts live in <session>/subagents/agent-<id>.jsonl, each with a .meta.json naming its tool call. */
  private scanSubagents(): boolean {
    const dir = path.join(path.dirname(this.file), path.basename(this.file, '.jsonl'), 'subagents');
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
    let changed = false;
    for (const n of names) {
      let s = this.subs.get(n);
      if (!s) {
        s = { offset: 0, trail: {} };
        try {
          const meta = JSON.parse(readFileSync(path.join(dir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
          if (typeof meta?.toolUseId === 'string') s.toolUseId = meta.toolUseId;
        } catch {
          // no meta: it can't be put under its tool call
        }
        this.subs.set(n, s);
      }
      const r = readAppended(path.join(dir, n), s.offset);
      s.offset = r.offset;
      for (const l of r.lines) applySubagentLine(s.trail, parse(l));
      const k = s.toolUseId ? this.state.kids.find((x) => x.id === s!.toolUseId) : undefined;
      if (k && r.lines.length) {
        if (k.state === 'run') k.last = s.trail.last;
        if (s.trail.at && s.trail.at > k.at) k.at = s.trail.at;
        changed = true;
      }
    }
    return changed;
  }
}
