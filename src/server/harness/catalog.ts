import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { existsSync, constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HARNESS_CATEGORIES, type HarnessCategory, type HarnessCatalog, type HarnessText } from '../../shared/harness.js';
import { HARNESS_GUIDES } from './guides.js';

export interface HarnessSource { name: string; dir: string; category?: HarnessCategory; files?: string[]; boundary?: string }
const MAX_FILES = 1200;
const MAX_VISITS = 6000;
const MAX_BYTES = 128 * 1024;
const SKIP = /^(?:node_modules|\.git|\.worktrees|worktrees|dist|build|\.venv|__pycache__|logs|sessions|credentials|secrets)$/i;
const SECRET = /(?:^|[./_-])(?:secrets?|credentials?|tokens?|auth|ovcli\.conf|ov\.conf)(?:[./_-]|$)|\.env(?:\.|$)|\.(?:pem|key|p12)$/i;
const TEXT = /\.(?:md|markdown|txt|ts|js|mjs|cjs|py|sh|ps1|yaml|yml|json|toml)$/i;
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const samePath = (a: string, b: string) => CASELESS ? a.toLowerCase() === b.toLowerCase() : a === b;
// O_NOFOLLOW exists on POSIX only; there it refuses a final component that became a link after validation.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
// Windows path stats report dev 0 (only handle stats carry the volume), so dev is compared when both have one.
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && (a.dev === b.dev || !a.dev || !b.dev);

export function sourceCategory(file: string, fallback: HarnessCategory = 'instructions'): HarnessCategory {
  if (/SKILL\.md$/i.test(file)) return 'skills';
  for (const c of HARNESS_CATEGORIES) if (file.toLowerCase().split(/[\\/._-]/).includes(c)) return c;
  if (/(?:memory|memories)/i.test(file)) return 'memory';
  if (/mcp/i.test(file)) return 'mcp';
  return fallback;
}

/** Only intentionally published folders, plus known instruction entrypoints, are indexed. */
export function harnessSources(project: string, local: boolean, env: NodeJS.ProcessEnv = process.env): HarnessSource[] {
  const sources: HarnessSource[] = [
    { name: 'Project instructions', dir: project, files: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] },
    ...['.harness', '.agents/skills', '.claude/skills', '.claude/commands', '.claude/rules', '.cursor/rules', '.github/instructions'].map((p) => ({ name: 'Project / ' + p, dir: path.join(project, p), boundary: project })),
  ];
  // A separate, intentionally public collection; never reinterpret private machine folders as shared.
  if (env.AGENT_OFFICE_SHARED_HARNESS_DIR) sources.push({ name: 'Shared harness', dir: path.resolve(env.AGENT_OFFICE_SHARED_HARNESS_DIR) });
  if (!local) return sources;
  if (env.AGENT_OFFICE_HARNESS_DIR) sources.push({ name: 'Published machine harness', dir: path.resolve(env.AGENT_OFFICE_HARNESS_DIR) });
  for (const p of ['.agents/skills', '.codex/skills', '.claude/skills', '.claude/commands']) sources.push({ name: 'Machine / ' + p, dir: path.join(os.homedir(), p), category: p.endsWith('commands') ? 'commands' : 'skills' });
  let viking = env.AGENT_OFFICE_OPENVIKING_DIR;
  if (!viking) {
    let parent = path.resolve(project);
    for (let depth = 0; depth < 7; depth++) {
      const candidates = [path.join(parent, 'OpenViking'), path.join(parent, '03.Agents-tools', 'OpenViking')];
      viking = candidates.find((p) => existsSync(path.join(p, 'agent-plugins', 'README.md')));
      if (viking || path.dirname(parent) === parent) break;
      parent = path.dirname(parent);
    }
  }
  if (viking) {
    for (const sub of ['agent-plugins', 'docs/en', 'examples']) sources.push({ name: 'OpenViking / ' + sub, dir: path.join(viking, sub), category: 'memory' });
  } else sources.push({ name: 'OpenViking (set AGENT_OFFICE_OPENVIKING_DIR)', dir: '', category: 'memory' });
  return sources;
}

/** Where list() found a file: its path relative to the source, and the real root/boundary it was verified against. */
interface Located { source: HarnessSource; file: string; rel: string; root: string; boundary?: string }
export class HarnessLibrary {
  private locations = new Map<string, Located>();
  constructor(private sources: HarnessSource[]) {}
  async list(): Promise<HarnessCatalog> {
    this.locations.clear();
    const entries = HARNESS_GUIDES.map(({ text: _text, ...entry }) => entry);
    const sources: HarnessCatalog['sources'] = [];
    let visits = 0;
    let limited = false;
    for (const source of this.sources) {
      let root: string | undefined, boundary: string | undefined;
      try {
        const stat = source.dir ? await lstat(source.dir) : undefined;
        if (stat?.isDirectory() && !stat.isSymbolicLink()) root = await realpath(source.dir);
        if (root && source.boundary && !inside(boundary = await realpath(source.boundary), root)) root = undefined;
      } catch { root = undefined; /* optional source */ }
      sources.push({ name: source.name, available: !!root });
      if (!root) continue;
      const verified = root;
      const walk = async (rel: string, depth: number): Promise<void> => {
        if (++visits > MAX_VISITS || entries.length >= MAX_FILES || depth > 10) { limited = true; return; }
        const file = path.join(source.dir, rel);
        let stat;
        try { stat = await lstat(file); } catch { return; }
        if (stat.isSymbolicLink() || SECRET.test(rel)) return;
        if (stat.isDirectory()) {
          if (SKIP.test(path.basename(file))) return;
          const children = await readdir(file).catch(() => []);
          for (const name of children.sort()) {
            if (visits >= MAX_VISITS || entries.length >= MAX_FILES) { limited = true; break; }
            await walk(path.join(rel, name), depth + 1);
          }
        } else if (stat.isFile() && TEXT.test(rel) && stat.size <= MAX_BYTES) {
          const id = createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 24);
          if (this.locations.has(id)) return;
          this.locations.set(id, { source, file, rel, root: verified, boundary });
          entries.push({ id, title: this.title(rel), category: sourceCategory(rel, source.category), source: source.name, path: rel.replaceAll('\\', '/') });
        }
      };
      if (source.files) { for (const file of source.files) await walk(file, 0); }
      else await walk('', 0);
    }
    return { entries, sources, limited };
  }
  private title(file: string): string {
    return /^SKILL\.md$/i.test(path.basename(file)) ? path.basename(path.dirname(file)) + ' / SKILL.md' : path.basename(file);
  }
  async read(id: string): Promise<HarnessText | undefined> {
    const guide = HARNESS_GUIDES.find((g) => g.id === id);
    if (guide) return { ...guide };
    const found = this.locations.get(id);
    if (!found) return undefined;
    const { source, file } = found;
    try {
      const before = await this.verify(found);
      if (!before) return undefined;
      const handle = await open(before.real, READ_FLAGS);
      try {
        // The opened file must be the one just verified, not whatever a swapped path now points at.
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || !sameFile(stat, before.stat) || stat.size > MAX_BYTES) return undefined;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES || buffer.subarray(0, bytesRead).includes(0)) return undefined;
        // Verify again after reading, so a path swapped out and back around the open is caught too.
        const after = await this.verify(found);
        if (!after || !sameFile(stat, after.stat)) return undefined;
        const rel = found.rel.replaceAll('\\', '/');
        return { id, title: this.title(file), category: sourceCategory(rel, source.category), source: source.name, path: rel, text: buffer.subarray(0, bytesRead).toString('utf8') };
      } finally { await handle.close(); }
    } catch { return undefined; }
  }
  /**
   * A successful list() is not a standing grant: every read re-checks, against the disk as it is now,
   * that the boundary and the source folder still resolve to the real paths list() verified, that no
   * component from the source folder down to the file is a link (list() never follows one, even to a
   * target inside the boundary), and that the file's real path is exactly that file under the root.
   * These are path checks, so they narrow a concurrent rename race rather than rule it out at the OS level.
   */
  private async verify({ source, file, rel, root, boundary }: Located) {
    if (boundary !== undefined && (!source.boundary || (await realpath(source.boundary)) !== boundary || !inside(boundary, root))) return;
    for (let at = source.dir, parts = rel.split(path.sep); ; at = path.join(at, parts.shift()!)) {
      if ((await lstat(at)).isSymbolicLink()) return;
      if (!parts.length) break;
    }
    const real = await realpath(file);
    if ((await realpath(source.dir)) !== root || !inside(root, real) || !samePath(path.relative(root, real), rel)) return;
    const stat = await lstat(real, { bigint: true });
    return stat.isFile() ? { real, stat } : undefined;
  }
}
