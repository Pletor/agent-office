import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

interface Located { source: HarnessSource; file: string }
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
      let available = false;
      try { available = !!source.dir && (await lstat(source.dir)).isDirectory() && !(await lstat(source.dir)).isSymbolicLink(); } catch { /* optional source */ }
      if (available && source.boundary) {
        try { available = inside(await realpath(source.boundary), await realpath(source.dir)); } catch { available = false; }
      }
      sources.push({ name: source.name, available });
      if (!available) continue;
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
          this.locations.set(id, { source, file });
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
      const root = await realpath(source.dir);
      const resolved = await realpath(file);
      if (!inside(root, resolved) || (await lstat(file)).isSymbolicLink()) return undefined;
      const handle = await open(resolved, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES || buffer.subarray(0, bytesRead).includes(0)) return undefined;
        const rel = path.relative(source.dir, file).replaceAll('\\', '/');
        return { id, title: this.title(file), category: sourceCategory(rel, source.category), source: source.name, path: rel, text: buffer.subarray(0, bytesRead).toString('utf8') };
      } finally { await handle.close(); }
    } catch { return undefined; }
  }
}
