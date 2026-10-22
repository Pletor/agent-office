import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
/** The pinned install next to Opora's tools, tried before npx. */
export const PR_LENS_LOCAL_CLI = 'P:\\0. OSVC\\8. Code\\07. Aplikace\\02.Opora-control-center\\tools\\pr-lens\\node_modules\\.bin\\pr-lens';
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

/** `AGENT_OFFICE_PR_LENS_CLI`, else the pinned local install when it exists, else the pinned npx command. */
export function prLensCli(env: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync): string {
  const set = (env.AGENT_OFFICE_PR_LENS_CLI ?? '').trim();
  if (set) return set;
  return exists(PR_LENS_LOCAL_CLI) ? `& "${PR_LENS_LOCAL_CLI}"` : PR_LENS_NPX;
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
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_SPEC) return undefined;
    const text = readFileSync(file, 'utf8');
    const doc = JSON.parse(text) as unknown;
    if (!isObject(doc) || doc.kind !== 'graph') return undefined;
    return { text, doc, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), validatedAt: stat.mtime.toISOString() };
  } catch { return undefined; }
}

const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v : '').replace(/[\r\n\t`|[\]<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_CARDS = 25;

/** The short text the pull request carries: title, summary, the changed cards with their files, the flows' names. */
export function lensMarkdown(spec: LensSpec): string {
  const doc = spec.doc;
  const lines = ['## PR Lens', ''];
  const title = clean(doc.title), summary = clean(doc.summary, 600);
  if (title) lines.push(`**${title}**`, '');
  if (summary) lines.push(summary, '');
  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []).filter(isObject);
  const groups: [string, string][] = [['added', 'Přidáno'], ['modified', 'Změněno'], ['removed', 'Odstraněno']];
  let shown = 0, hidden = 0;
  for (const [delta, label] of groups) {
    const cards = nodes.filter((n) => n.delta === delta);
    if (!cards.length) continue;
    lines.push(`${label}:`);
    for (const card of cards) {
      if (shown >= MAX_CARDS) { hidden++; continue; }
      shown++;
      const files = (Array.isArray(card.files) ? card.files : []).filter(isObject).map((f) => clean(f.path, 200)).filter(Boolean);
      lines.push(`- ${clean(card.label ?? card.id, 100) || 'karta'}${files.length ? ` (${files.slice(0, 4).map((f) => `\`${f}\``).join(', ')}${files.length > 4 ? ', …' : ''})` : ''}`);
    }
    lines.push('');
  }
  if (hidden) lines.push(`…a dalších ${hidden} karet ve specifikaci.`, '');
  const flows = (Array.isArray(doc.flows) ? doc.flows : []).filter(isObject).map((f) => clean(f.title ?? f.id, 100)).filter(Boolean);
  if (flows.length) lines.push(`Toky: ${flows.slice(0, 10).join(', ')}${flows.length > 10 ? ', …' : ''}`, '');
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
  specSha256: string; specBytes: number; spec?: unknown; note?: string;
}
export type LensOutcome = 'recorded' | 'not-deployed' | 'conflict' | 'failed';

/** POST /api/oporahub/review-jobs/lens as the office's agent, with the execution's credentials like every execution post. 404: Canvas doesn't take it yet, which is fine. */
export async function postLens(base: string, agent: string, transport: typeof fetch, lease: ExecutionLease, lens: LensEvidence): Promise<LensOutcome> {
  try {
    const response = await transport(new URL('/api/oporahub/review-jobs/lens', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(base).origin, 'X-Opora-Actor': `agent; name=${agent}` },
      body: JSON.stringify({ project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch, executionId: lease.executionId, lens }),
    });
    if (response.ok) return 'recorded';
    return response.status === 404 ? 'not-deployed' : response.status === 409 ? 'conflict' : 'failed';
  } catch { return 'failed'; }
}

export function lensEvent(lease: Pick<ExecutionLease, 'project' | 'workspace' | 'nodeId' | 'executionId'>, lens: LensEvidence, outcome: LensOutcome): ProcessInput {
  return {
    kind: 'pr.lens', phase: 'review', state: 'ok',
    title: `PR Lens spec u PR #${lens.prNumber}`,
    detail: `head ${lens.headSha.slice(0, 12)} · Canvas: ${outcome}`,
    refs: { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, sha: lens.headSha, pr: lens.prNumber },
  };
}

/** What the attachment runs, the same narrow gh/Canvas the handoff fakes in tests. */
export interface LensTools { gh(args: string[], cwd: string): Promise<string>; transport: typeof fetch; env: NodeJS.ProcessEnv }
export interface PreparedLens { spec: LensSpec; markdown: string }

/** The handoff's PR Lens step. Every failure here is swallowed: a diagram is evidence, never a gate. */
export class PrLensAttachment {
  constructor(private base: string, private agent: string, private tools: LensTools) {}

  /** The worker's spec and its text summary for this head; undefined when off, absent, or unusable. */
  prepare(dir: string, at: { headSha: string }): PreparedLens | undefined {
    if (!prLensEnabled(this.tools.env) || !SHA.test(at.headSha)) return undefined;
    const spec = findLensSpec(dir);
    return spec && { spec, markdown: lensMarkdown(spec) };
  }

  /** On a pull request that already existed, the summary goes in a comment instead of the body. */
  async comment(repository: string, number: number, lens: PreparedLens, dir: string): Promise<void> {
    await this.tools.gh(['pr', 'comment', String(number), '--repo', repository, '--body', lens.markdown], dir).catch(() => undefined);
  }

  /** Sends the spec to Canvas (optional evidence, while the lease is still held) and tells the process journal. */
  async report(lease: ExecutionLease, pr: { number: number; headSha: string }, lens: PreparedLens): Promise<LensOutcome> {
    const { spec } = lens;
    const inline = spec.bytes <= MAX_INLINE_SPEC;
    const evidence: LensEvidence = { prNumber: pr.number, headSha: pr.headSha, validatedAt: spec.validatedAt, specSha256: spec.sha256, specBytes: spec.bytes,
      ...(inline ? { spec: spec.doc } : { note: 'spec too large' }) };
    const outcome = await postLens(this.base, this.agent, this.tools.transport, lease, evidence);
    emitProcess(this.agent, lensEvent(lease, evidence, outcome));
    return outcome;
  }
}
