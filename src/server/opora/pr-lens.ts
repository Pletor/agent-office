import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProcessInput } from '../process/journal.js';
import { emitProcess } from '../process/hub.js';
import type { ExecutionLease } from './execution-client.js';

/**
 * PR Lens (github.com/coldteadotai/pr-lens, MIT) as review evidence, following Canvas's
 * docs/cista-linie.md §4. The worker that made the change draws it: it writes a graph document,
 * validates it and renders it locally with the PR Lens CLI (no hosted app, no `analyze` with a model
 * key, no `canvas push`); the render only exists to produce `drawn.graph.json`, the validated spec with
 * the name corrections applied. When the office hands the pull request off it reads that spec from the
 * worktree and (1) sends it to Canvas as structured evidence (`POST /api/oporahub/review-jobs/lens`,
 * with the execution's lease token, optional and never blocking), (2) puts a short TEXT summary built
 * from it in the pull request. Nothing else is published to GitHub: no side branches, no images.
 * No spec, an unusable one, or `AGENT_OFFICE_OPORA_PR_LENS=off`: nothing happens.
 */

/** The CLI, pinned: `@coldtea/pr-lens-renderer@0.3.3` was published with a `workspace:*` dependency that npm can't install. */
export const PR_LENS_NPX = 'npx -y -p @coldtea/pr-lens-cli@0.13.2 -p @coldtea/pr-lens-renderer@0.3.2 pr-lens';
/** Where the worker writes the document and the render, relative to its worktree. */
export const PR_LENS_GRAPH = '.pr-lens/graph.json';
export const PR_LENS_RENDER = '.pr-lens/render';
export const PR_LENS_DIR = '.pr-lens/';

/** The spec goes inline in Canvas's evidence up to this size; a bigger one is announced by size and hash only. */
const MAX_INLINE_SPEC = 64 * 1024, MAX_SPEC = 8 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;

/** `AGENT_OFFICE_OPORA_PR_LENS=off` (or `0`, `false`, `no`) turns it off; it is on by default. */
export function prLensEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(?:0|off|false|no)$/i.test((env.AGENT_OFFICE_OPORA_PR_LENS ?? '').trim());
}

/**
 * The CLI as an argument list for execFile (no shell): `AGENT_OFFICE_PR_LENS_CLI` (a single executable path),
 * else `node_modules/.bin/pr-lens` under `AGENT_OFFICE_PR_LENS_HOME` when that exists, else the pinned npx.
 */
export function prLensArgv(env: NodeJS.ProcessEnv, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string[] {
  const set = (env.AGENT_OFFICE_PR_LENS_CLI ?? '').trim();
  if (set) return [set];
  const home = (env.AGENT_OFFICE_PR_LENS_HOME ?? '').trim();
  if (home) {
    const bin = path.join(home, 'node_modules', '.bin', platform === 'win32' ? 'pr-lens.cmd' : 'pr-lens');
    if (exists(bin)) return [bin];
  }
  return PR_LENS_NPX.split(' ');
}

/** The same command as text for the worker's brief, with a path that has spaces in double quotes. */
export function prLensCli(env: NodeJS.ProcessEnv, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string {
  return prLensArgv(env, platform, exists).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** The worker's instruction, appended to its execution prompt while the feature is on. */
export function prLensInstructions(env: NodeJS.ProcessEnv = process.env): string {
  const cli = prLensCli(env);
  return `Before submitting a code change, draw it with PR Lens (optional review evidence; skip it if the CLI won't run, never let it block the result). Read the format once with \`${cli} skill\`, write the graph document of your diff against the base to ${PR_LENS_GRAPH}, run \`${cli} validate ${PR_LENS_GRAPH}\` until it passes, then \`${cli} render ${PR_LENS_GRAPH} --theme light --out ${PR_LENS_RENDER}\` (the render only produces ${PR_LENS_RENDER}/drawn.graph.json, the validated spec with name corrections applied). \`${PR_LENS_DIR}\` is excluded from git in your worktree: never \`git add\` it (or a .gitignore line the CLI adds), so it stays out of the pull request. Never run \`analyze\`, \`canvas\` or \`auth\`: Office sends the spec to Canvas and a text summary to the pull request itself. Reviewers and the next agents read your validated spec instead of screenshots, so make card names exact and give each card its real file paths and line ranges; put naming fixes in .github/pr-lens.yml, not in the SVG.`;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface LensSpec { text: string; sha256: string; bytes: number; validatedAt: string; doc: Json }

/** The worker's validated spec (`drawn.graph.json`, a `kind: graph` document), or undefined. */
export function findLensSpec(dir: string): LensSpec | undefined {
  const file = path.join(dir, PR_LENS_RENDER, 'drawn.graph.json');
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SPEC) return undefined;
    const text = readFileSync(file, 'utf8');
    const doc = JSON.parse(text) as unknown;
    if (!isObject(doc) || doc.kind !== 'graph') return undefined;
    return { text, doc, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), validatedAt: stat.mtime.toISOString() };
  } catch { return undefined; }
}

/** Untrusted spec text as one inline code span: no backticks, controls or line breaks, capped. Inside a span `@x`, `#1` and URLs stay inert. */
const code = (v: unknown, max = 200): string => {
  const t = (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t ? `\`${t}\`` : '';
};
const MAX_CARDS = 25;

/** The spec was drawn for this head: its `provenance.head.sha` (7 to 40 hex) is the PR head or a prefix of it. */
export function lensIsFresh(spec: LensSpec, headSha: string): boolean {
  const prov = spec.doc.provenance, head = isObject(prov) && isObject(prov.head) ? prov.head.sha : undefined;
  return typeof head === 'string' && /^[a-f0-9]{7,40}$/i.test(head) && headSha.toLowerCase().startsWith(head.toLowerCase());
}

/** The short text the pull request carries: title, summary, the changed cards with their files, the flows' names. Every spec string is inside a code span. */
export function lensMarkdown(spec: LensSpec, stale = false): string {
  const doc = spec.doc;
  const lines = ['## PR Lens', ''];
  if (stale) lines.push('Lens je ze starší verze (neodpovídá hlavě tohoto PR); podrobnosti viz Opora → karta → Lens.', '');
  else {
    const title = code(doc.title), summary = code(doc.summary, 600);
    if (title) lines.push(`Název: ${title}`, '');
    if (summary) lines.push(`Shrnutí: ${summary}`, '');
    const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []).filter(isObject);
    const groups: [string, string][] = [['added', 'Přidáno'], ['modified', 'Změněno'], ['removed', 'Odstraněno']];
    let shown = 0, hidden = 0;
    for (const [delta, label] of groups) {
      const cards = nodes.filter((n) => n.delta === delta);
      if (!cards.length) continue;
      lines.push(`${label}:`, '');
      for (const card of cards) {
        if (shown >= MAX_CARDS) { hidden++; continue; }
        shown++;
        const files = (Array.isArray(card.files) ? card.files : []).filter(isObject).map((f) => code(f.path)).filter(Boolean);
        lines.push(`- ${code(card.label ?? card.id, 100) || 'karta'}${files.length ? ` (${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''})` : ''}`);
      }
      lines.push('');
    }
    if (hidden) lines.push(`…a dalších ${hidden} karet ve specifikaci.`, '');
    const flows = (Array.isArray(doc.flows) ? doc.flows : []).filter(isObject).map((f) => code(f.title ?? f.id, 100)).filter(Boolean);
    if (flows.length) lines.push(`Toky: ${flows.slice(0, 10).join(', ')}${flows.length > 10 ? ', …' : ''}`, '');
  }
  lines.push('Interaktivní pohled: Opora → karta → Lens');
  return lines.join('\n');
}
/** The body with the PR Lens section before its trailer block (Canvas reads the trailers at the end). */
export function withLensSection(body: string, section: string): string {
  const at = body.lastIndexOf('\n\n---\n\n');
  return at < 0 ? `${body}\n\n${section}` : `${body.slice(0, at)}\n\n${section}${body.slice(at)}`;
}

export interface LensEvidence {
  prNumber: number; headSha: string; validatedAt: string;
  /** The validated spec's SHA-256 and size; the spec itself only when it is at most 64 KiB, else `note`. */
  specSha256: string; specBytes: number; spec?: unknown; note?: string; stale?: boolean;
}
export type LensOutcome = 'recorded' | 'not-deployed' | 'conflict' | 'failed';
/** What Canvas answered: the outcome and, when it refused or couldn't be reached, why (its own error text, capped; never the request). */
export interface LensReply { outcome: LensOutcome; reason?: string }

/** Canvas's `{error}` text or the transport's message as one short line. */
const reasonText = (v: unknown): string => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** POST /api/oporahub/review-jobs/lens as the office's agent, with the execution's credentials like every execution post. 404: Canvas doesn't take it yet, which is fine. */
export async function postLens(base: string, agent: string, transport: typeof fetch, lease: ExecutionLease, lens: LensEvidence): Promise<LensReply> {
  try {
    const response = await transport(new URL('/api/oporahub/review-jobs/lens', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(base).origin, 'X-Opora-Actor': `agent; name=${agent}` },
      body: JSON.stringify({ project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch, executionId: lease.executionId, lens }),
    });
    if (response.ok) return { outcome: 'recorded' };
    const outcome: LensOutcome = response.status === 404 ? 'not-deployed' : response.status === 409 ? 'conflict' : 'failed';
    const said = await response.json().then((b: unknown) => (isObject(b) ? reasonText(b.error) : ''), () => '');
    return { outcome, reason: `HTTP ${response.status}${said ? `: ${said}` : ''}` };
  } catch (error) { return { outcome: 'failed', reason: reasonText((error as Error).message) || 'unreachable' }; }
}

export function lensEvent(lease: Pick<ExecutionLease, 'project' | 'workspace' | 'nodeId' | 'executionId'>, lens: LensEvidence, outcome: LensOutcome, reason?: string): ProcessInput {
  const failed = outcome === 'conflict' || outcome === 'failed';
  return {
    kind: 'pr.lens', phase: 'review', state: failed ? 'fail' : outcome === 'not-deployed' ? 'info' : lens.stale ? 'wait' : 'ok',
    title: `PR Lens spec u PR #${lens.prNumber}${failed ? ' se neuložil' : ''}`,
    detail: `head ${lens.headSha.slice(0, 12)} · ${lens.stale ? 'ze starší verze · ' : ''}Canvas: ${outcome}${reason ? ` (${reason})` : ''}`.slice(0, 240),
    refs: { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, sha: lens.headSha, pr: lens.prNumber },
  };
}

/** How long after a 409 the office tries the spec once more (Canvas may not have caught up with the PR link yet). */
export const LENS_RETRY_MS = 60_000;
const retryLater = (run: () => void) => { setTimeout(run, LENS_RETRY_MS).unref(); };

/** What the attachment runs, the same narrow gh/Canvas the handoff fakes in tests; `later` schedules the one retry after a 409. */
export interface LensTools { gh(args: string[], cwd: string): Promise<string>; transport: typeof fetch; env: NodeJS.ProcessEnv; later?: (run: () => void) => void }
type LensLog = (message: string, level: 'info' | 'warn' | 'error') => void;
export interface PreparedLens { spec: LensSpec; markdown: string; stale: boolean }

/** The handoff's PR Lens step. A failure never stops the handoff (a diagram is evidence, never a gate), but it is logged and shown in the live process. */
export class PrLensAttachment {
  constructor(private base: string, private agent: string, private tools: LensTools) {}

  /** The worker's spec and its text summary for this head; undefined when off, absent, or unusable. A spec drawn for another head is stale. */
  prepare(dir: string, at: { headSha: string }): PreparedLens | undefined {
    if (!prLensEnabled(this.tools.env) || !SHA.test(at.headSha)) return undefined;
    const spec = findLensSpec(dir);
    if (!spec) return undefined;
    const stale = !lensIsFresh(spec, at.headSha);
    return { spec, stale, markdown: lensMarkdown(spec, stale) };
  }

  /** On a pull request that already existed (and is still open), the summary goes in one comment that later handoffs update in place. */
  async comment(repository: string, number: number, lens: PreparedLens, dir: string): Promise<void> {
    try {
      const listed = JSON.parse((await this.tools.gh(['api', `repos/${repository}/issues/${number}/comments`, '--paginate', '--jq', '[.[] | select(.body | startswith("## PR Lens")) | .id]'], dir)).trim() || '[]') as unknown;
      const id = Array.isArray(listed) ? listed.find((v): v is number => typeof v === 'number') : undefined;
      if (id !== undefined) await this.tools.gh(['api', '-X', 'PATCH', `repos/${repository}/issues/comments/${id}`, '-f', `body=${lens.markdown}`], dir);
      else await this.tools.gh(['pr', 'comment', String(number), '--repo', repository, '--body', lens.markdown], dir);
    } catch { /* evidence, never a gate */ }
  }

  /**
   * Sends the spec to Canvas (optional evidence, with the execution's credentials, after its PR is linked) and tells
   * the process journal. A refusal or an unreachable Canvas is logged; a 409 is tried once more later. A stale spec is not sent inline.
   */
  async report(lease: ExecutionLease, pr: { number: number; headSha: string }, lens: PreparedLens, log: LensLog = () => {}): Promise<LensOutcome> {
    const { spec, stale } = lens;
    const inline = !stale && spec.bytes <= MAX_INLINE_SPEC;
    const evidence: LensEvidence = { prNumber: pr.number, headSha: pr.headSha, validatedAt: spec.validatedAt, specSha256: spec.sha256, specBytes: spec.bytes,
      ...(stale ? { stale: true, note: 'spec is from an older head' } : inline ? { spec: spec.doc } : { note: 'spec too large' }) };
    const outcome = await this.send(lease, evidence, log, false);
    if (outcome === 'conflict') (this.tools.later ?? retryLater)(() => { void this.send(lease, evidence, log, true); });
    return outcome;
  }

  private async send(lease: ExecutionLease, evidence: LensEvidence, log: LensLog, retry: boolean): Promise<LensOutcome> {
    const { outcome, reason } = await postLens(this.base, this.agent, this.tools.transport, lease, evidence);
    emitProcess(this.agent, lensEvent(lease, evidence, outcome, reason));
    if (outcome === 'conflict' || outcome === 'failed') {
      const next = outcome === 'conflict' && !retry ? '; trying once more later' : '';
      log(`🛰️ PR Lens for ${lease.executionId} (PR #${evidence.prNumber})${retry ? ' on retry' : ''} wasn't stored by Canvas: ${outcome} (${reason ?? 'no reason'})${next}`, 'warn');
    } else if (retry) log(`🛰️ PR Lens for ${lease.executionId} (PR #${evidence.prNumber}) on retry: ${outcome}`, 'info');
    return outcome;
  }
}
