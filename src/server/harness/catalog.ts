import { readdir, lstat, realpath, open, type FileHandle } from 'node:fs/promises';
import { existsSync, constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HARNESS_CATEGORIES, type HarnessCategory, type HarnessCatalog, type HarnessEntry, type HarnessText, type HarnessResolution } from '../../shared/harness.js';
import { HARNESS_GUIDES } from './guides.js';
import { HarnessRegistry, sourceInstance, type Observed } from './registry.js';
import { DigestCache } from './digests.js';

/**
 * A published folder. `ns` and `prefix` give its elements their identity: an element's ID is derived
 * from the namespace and its path from the namespace root (`prefix/<path in the folder>`), never from
 * where the folder happens to be on disk, so moving a checkout or restarting keeps every ID.
 */
export interface HarnessSource { name: string; dir: string; category?: HarnessCategory; files?: string[]; boundary?: string; ns?: string; prefix?: string }
const MAX_FILES = 1200;
const MAX_VISITS = 6000;
const MAX_BYTES = 128 * 1024;
const SKIP = /^(?:node_modules|\.git|\.worktrees|worktrees|dist|build|\.venv|__pycache__|logs|sessions|credentials|secrets)$/i;
/**
 * Credential-like names, tested on the slash form of the source-relative path (so a folder on the
 * path counts too). Word-bounded names (`auth.json`, `my-secrets/`) keep `authors.md` and
 * `authentication.md` listed; `token`, `password`, `apikey`/`api-key` are excluded wherever they
 * appear; key files, env files, service-account JSON and kubeconfigs by name. Not a secret scanner.
 */
const SECRET = /(?:^|[./_-])(?:secrets?|credentials?|auth|ovcli\.conf|ov\.conf)(?:[./_-]|$)|(?:^|\/)(?:id_rsa|id_ed25519|kubeconfig|service-account[^/]*\.json)|tokens?|password|api[_-]?key|\.env(?:\.|$)|\.(?:pem|key|p12)$/i;
const TEXT = /\.(?:md|markdown|txt|ts|js|mjs|cjs|py|sh|ps1|yaml|yml|json|toml)$/i;
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const samePath = (a: string, b: string) => CASELESS ? a.toLowerCase() === b.toLowerCase() : a === b;
// O_NOFOLLOW exists on POSIX only; there it refuses a final component that became a link after validation.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
// Windows path stats report dev 0 (only handle stats carry the volume), so dev is compared when both have one.
const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && (a.dev === b.dev || !a.dev || !b.dev);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const posix = (p: string) => p.replaceAll('\\', '/');
const fileKey = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs].join(':');
/** The namespaces whose elements may be bound in the global layer; a project element would resolve to a different file in every other project. */
const GLOBAL_NAMESPACES = new Set(['handbook', 'machine', 'published', 'openviking']);
/** The namespace an ID names, without a lookup: `guide:` → handbook, `el:<ns>:` → ns; a legacy alias names none. */
export const elementNamespace = (id: string): string | undefined => id.startsWith('guide:') ? 'handbook' : /^el:([a-z]+):/.exec(id)?.[1];
export const globalNamespace = (ns: string | undefined) => !!ns && GLOBAL_NAMESPACES.has(ns);

const SINGULAR: Record<string, HarnessCategory> = { instruction: 'instructions', skill: 'skills', hook: 'hooks', rule: 'rules', command: 'commands', script: 'scripts', tool: 'tools', plugin: 'plugins', permission: 'permissions', test: 'testing', tests: 'testing', ops: 'operations', runbook: 'operations', runbooks: 'operations' };
/** The first category name on the path wins (`runbooks/hooks.md` is a runbook), whichever form it takes; a SKILL.md is always a skill. */
export function sourceCategory(file: string, fallback: HarnessCategory = 'instructions'): HarnessCategory {
  if (/SKILL\.md$/i.test(file)) return 'skills';
  const parts = file.toLowerCase().split(/[\\/._-]/);
  for (const p of parts) {
    if ((HARNESS_CATEGORIES as readonly string[]).includes(p)) return p as HarnessCategory;
    if (SINGULAR[p]) return SINGULAR[p];
  }
  if (/(?:memory|memories)/i.test(file)) return 'memory';
  if (/mcp/i.test(file)) return 'mcp';
  return fallback;
}
/** The shelf inside a category: the folder right under the category folder, else the first folder, else the source. */
export function sourceGroup(file: string, category: HarnessCategory, source: string): string {
  const parts = posix(file).split('/');
  const at = parts.findIndex((p) => p.toLowerCase() === category || SINGULAR[p.toLowerCase()] === category);
  const below = at >= 0 ? parts.slice(at + 1, -1) : parts.slice(0, -1);
  return below[0] ?? source;
}

/** Only intentionally published folders, plus known instruction entrypoints, are indexed. */
export function harnessSources(project: string, local: boolean, env: NodeJS.ProcessEnv = process.env): HarnessSource[] {
  const sources: HarnessSource[] = [
    { name: 'Project instructions', dir: project, files: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'], ns: 'project', prefix: '' },
    ...['.harness', '.agents/skills', '.claude/skills', '.claude/commands', '.claude/rules', '.cursor/rules', '.github/instructions'].map((p) => ({ name: 'Project / ' + p, dir: path.join(project, p), boundary: project, ns: 'project', prefix: p })),
  ];
  if (!local) return sources;
  if (env.AGENT_OFFICE_HARNESS_DIR) sources.push({ name: 'Published machine harness', dir: path.resolve(env.AGENT_OFFICE_HARNESS_DIR), ns: 'published', prefix: '' });
  for (const p of ['.agents/skills', '.codex/skills', '.claude/skills', '.claude/commands']) sources.push({ name: 'Machine / ' + p, dir: path.join(os.homedir(), p), category: p.endsWith('commands') ? 'commands' : 'skills', ns: 'machine', prefix: p });
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
    for (const sub of ['agent-plugins', 'docs/en', 'examples']) sources.push({ name: 'OpenViking / ' + sub, dir: path.join(viking, sub), category: 'memory', ns: 'openviking', prefix: sub });
  } else sources.push({ name: 'OpenViking (set AGENT_OFFICE_OPENVIKING_DIR)', dir: '', category: 'memory', ns: 'openviking', prefix: '' });
  return sources;
}

/** Element identity: `el:<namespace>:<20 hex>` from the namespace and the namespace-relative path (case-folded where the filesystem is). */
export function elementId(source: HarnessSource, rel: string): { id: string; ns: string; key: string } {
  const ns = source.ns ?? 'source', prefix = source.prefix ?? source.name;
  let key = path.posix.join(prefix, posix(rel));
  if (CASELESS) key = key.toLowerCase();
  return { id: 'el:' + ns + ':' + sha256(ns + '\0' + key).slice(0, 20), ns, key };
}
/** The ID an element had before the registry existed: a hash of its absolute path. Kept as an alias. */
const legacyId = (file: string) => sha256(path.resolve(file)).slice(0, 24);

/** Where list() found a file: its path relative to the source, and the real root/boundary it was verified against. */
interface Located { source: HarnessSource; file: string; rel: string; root: string; boundary?: string; entry: HarnessEntry }
/** Why a listed path yielded no content: a property of the content (binary, too large) or a read that could not be completed now. */
interface Skipped { skip: 'binary' | 'size' | 'unreadable' }
export class HarnessLibrary {
  private locations = new Map<string, Located>();
  private aliases = new Map<string, string>();
  private versions = new Map<string, number>();
  private digests: DigestCache;
  /** The namespaces this library publishes: what resolve() may describe. Legacy `source` namespace covers ad-hoc sources (tests). */
  private visible: Set<string>;
  constructor(private sources: HarnessSource[], readonly registry?: HarnessRegistry) {
    this.digests = registry?.digests ?? DigestCache.memory();
    this.visible = new Set(['handbook', ...sources.map((s) => s.ns ?? 'source')]);
  }
  async list(): Promise<HarnessCatalog> {
    this.locations.clear();
    this.aliases.clear();
    const entries: HarnessEntry[] = HARNESS_GUIDES.map(({ text: _text, ...entry }) => entry);
    const observed: Observed[] = HARNESS_GUIDES.map((g) => ({ id: g.id, ns: 'handbook', key: g.path, root: 'handbook', title: g.title, path: g.path, source: g.source, category: g.category, digest: g.digest }));
    const sources: HarnessCatalog['sources'] = [];
    const complete = new Set<string>([sourceInstance('Harness handbook', 'handbook')]);
    const roots: Record<string, string> = {};
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
      const verified = root, instance = sha256(CASELESS ? root.toLowerCase() : root).slice(0, 16);
      roots[instance] = root;
      let whole = true;
      const walk = async (rel: string, depth: number): Promise<void> => {
        if (++visits > MAX_VISITS || entries.length >= MAX_FILES || depth > 10) { limited = true; whole = false; return; }
        const file = path.join(source.dir, rel);
        let stat;
        // A path that vanished is simply absent; any other failure (permissions, a lock) leaves the walk incomplete, so nothing below it is declared missing.
        try { stat = await lstat(file, { bigint: true }); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') whole = false; return; }
        // Tested on the slash form, so a nested credential-like name is caught on Windows paths too.
        if (stat.isSymbolicLink() || SECRET.test(posix(rel))) return;
        if (stat.isDirectory()) {
          if (SKIP.test(path.basename(file))) return;
          const children = await readdir(file).catch(() => { whole = false; return []; });
          for (const name of children.sort()) {
            if (visits >= MAX_VISITS || entries.length >= MAX_FILES) { limited = true; whole = false; break; }
            await walk(path.join(rel, name), depth + 1);
          }
        } else if (stat.isFile() && TEXT.test(rel) && stat.size <= MAX_BYTES) {
          const { id, ns, key } = elementId(source, rel);
          if (this.locations.has(id)) return;
          const alias = legacyId(file);
          const category = sourceCategory(rel, source.category);
          const entry: HarnessEntry = { id, title: this.title(rel), category, group: sourceGroup(rel, category, source.name), source: source.name, path: posix(rel), version: 0, digest: '', aliases: [alias] };
          const located: Located = { source, file, rel, root: verified, boundary, entry };
          const digest = await this.digest(located, stat);
          // Binary content or content past the limit is not an element. Anything else (a denied or busy
          // read, a path swapped meanwhile) leaves the walk incomplete, so the element is not declared missing.
          if (typeof digest !== 'string') { if (digest.skip === 'unreadable') whole = false; return; }
          entry.digest = digest;
          this.locations.set(id, located);
          this.aliases.set(alias, id);
          observed.push({ id, ns, key, root: instance, title: entry.title, path: entry.path, source: source.name, category, digest });
          entries.push(entry);
        }
      };
      if (source.files) { for (const file of source.files) await walk(file, 0); }
      else await walk('', 0);
      if (whole) complete.add(sourceInstance(source.name, instance));
    }
    this.digests.flush();
    this.versions = await this.registry?.observe(observed, complete, roots) ?? new Map();
    for (const entry of entries) entry.version = this.versions.get(entry.id) ?? 0;
    return { entries, sources, limited };
  }
  /** SHA-256 of a listed file, read with the same verification as read(); the cache is keyed by the file ID, size and mtime the walk saw. */
  private async digest(located: Located, seen: BigIntStats): Promise<string | Skipped> {
    const key = fileKey(seen), cached = this.digests.get(located.file, key);
    if (cached) return cached;
    const content = await this.content(located);
    if ('skip' in content) return content;
    if (!sameFile(content.stat, seen)) return { skip: 'unreadable' };
    const digest = sha256(content.bytes);
    this.digests.set(located.file, key, digest);
    return digest;
  }
  /**
   * The bytes of a located file, or why there are none. The path is verified against the boundary
   * before the open, the opened handle must be the file just verified (not whatever a swapped path
   * now points at), and the path is verified again after reading, so a path swapped out and back
   * around the open is caught too. Binary content and content past the size limit are refused for
   * what they are; a failed verification or a refused read (EACCES, EPERM, EBUSY) is `unreadable`.
   */
  private async content(located: Located): Promise<{ bytes: Buffer; stat: BigIntStats } | Skipped> {
    const before = await this.verify(located);
    if (!before) return { skip: 'unreadable' };
    let handle: FileHandle;
    try { handle = await open(before.real, READ_FLAGS); } catch { return { skip: 'unreadable' }; }
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || !sameFile(stat, before.stat)) return { skip: 'unreadable' };
      if (stat.size > MAX_BYTES) return { skip: 'size' };
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) return { skip: 'size' };
      if (buffer.subarray(0, bytesRead).includes(0)) return { skip: 'binary' };
      const after = await this.verify(located);
      if (!after || !sameFile(stat, after.stat)) return { skip: 'unreadable' };
      return { bytes: buffer.subarray(0, bytesRead), stat };
    } catch { return { skip: 'unreadable' }; } finally { await handle.close(); }
  }
  private title(file: string): string {
    return /^SKILL\.md$/i.test(path.basename(file)) ? path.basename(path.dirname(file)) + ' / SKILL.md' : path.basename(file);
  }
  /** Where an ID points: the current element, a tombstone of one listed before, or nothing. Aliases resolve too. */
  resolve(id: string): HarnessResolution {
    const canonical = this.aliases.get(id) ?? id;
    const guide = HARNESS_GUIDES.find((g) => g.id === canonical);
    if (guide) { const { text: _text, ...entry } = guide; return { status: 'available', entry: { ...entry, version: this.versions.get(canonical) ?? 0 } }; }
    const found = this.locations.get(canonical);
    if (found) return { status: 'available', entry: found.entry };
    // Known to this installation but not listed here: gone from where it lived (missingSince set), or published in another project only.
    // A namespace this library does not publish (machine folders for a non-admin) is not described at all.
    const known = this.registry?.lookup(canonical);
    if (known && this.visible.has(known.ns)) { const { ns: _ns, ...rest } = known; return { status: 'missing', id: canonical, ...rest, version: known.revision }; }
    return { status: 'unknown', id };
  }
  async read(id: string): Promise<HarnessText | undefined> {
    id = this.aliases.get(id) ?? id;
    const guide = HARNESS_GUIDES.find((g) => g.id === id);
    if (guide) return { ...guide, version: this.versions.get(id) ?? 0 };
    const found = this.locations.get(id);
    if (!found) return undefined;
    const content = await this.content(found);
    if ('skip' in content) return undefined;
    // The digest is of the bytes just read; the version stays the one listed (a new revision is assigned by the next listing).
    return { ...found.entry, digest: sha256(content.bytes), text: content.bytes.toString('utf8') };
  }
  /**
   * A successful list() is not a standing grant: every read re-checks, against the disk as it is now,
   * that the boundary and the source folder still resolve to the real paths list() verified, that no
   * component from the source folder down to the file is a link (list() never follows one, even to a
   * target inside the boundary), and that the file's real path is exactly that file under the root.
   * These are path checks, so they narrow a concurrent rename race rather than rule it out at the OS level.
   */
  private async verify({ source, file, rel, root, boundary }: Located) {
    try {
      if (boundary !== undefined && (!source.boundary || (await realpath(source.boundary)) !== boundary || !inside(boundary, root))) return;
      for (let at = source.dir, parts = rel.split(path.sep); ; at = path.join(at, parts.shift()!)) {
        if ((await lstat(at)).isSymbolicLink()) return;
        if (!parts.length) break;
      }
      const real = await realpath(file);
      if ((await realpath(source.dir)) !== root || !inside(root, real) || !samePath(path.relative(root, real), rel)) return;
      const stat = await lstat(real, { bigint: true });
      return stat.isFile() ? { real, stat } : undefined;
    } catch { return undefined; }
  }
}
