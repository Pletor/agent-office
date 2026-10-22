import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProcessInput } from '../process/journal.js';
import { emitProcess } from '../process/hub.js';
import type { ExecutionLease } from './execution-client.js';

/**
 * PR Lens (github.com/coldteadotai/pr-lens, MIT) as review evidence, following Canvas's
 * docs/cista-linie.md §4. The worker that made the change draws it: it writes a graph document,
 * validates it and renders it locally with the PR Lens CLI (no hosted app, no `analyze` with a model
 * key, no `canvas push`). When the office hands the pull request off, it looks for that render in the
 * worktree; if there is one it puts the validated spec (the drawn graph document) and the top diagram on
 * a side branch `pr-lens/<head branch>` through the GitHub API (plain `gh`, nothing else), shows the
 * picture in the pull request, and tells Canvas where both are, with the spec itself when it's small
 * (`POST /api/oporahub/review-jobs/lens`, optional and never blocking). The spec is the source of truth
 * agents read; the SVG is for people. No render, an unusable one, or
 * `AGENT_OFFICE_OPORA_PR_LENS=off`: nothing happens and the pull request goes out as before.
 */

/** The CLI, pinned: `@coldtea/pr-lens-renderer@0.3.3` was published with a `workspace:*` dependency that npm can't install. */
export const PR_LENS_NPX = 'npx -y -p @coldtea/pr-lens-cli@0.13.2 -p @coldtea/pr-lens-renderer@0.3.2 pr-lens';
/** Where the worker writes the document and the render, relative to its worktree. */
export const PR_LENS_GRAPH = '.pr-lens/graph.json';
export const PR_LENS_RENDER = '.pr-lens/render';

const MAX_SVG = 1024 * 1024;
/** The spec goes on the side branch up to this size, and inline in Canvas's evidence up to the smaller one. */
const MAX_SPEC = 512 * 1024, MAX_INLINE_SPEC = 64 * 1024;
export const LENS_SPEC_FILE = 'spec.json';
const SVG_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.svg$/;
const SHA = /^[a-f0-9]{40}$/;
/** What a PR Lens SVG never carries (it is self-contained and script-free); one that does isn't ours to publish. */
const UNSAFE = /<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `AGENT_OFFICE_OPORA_PR_LENS=off` (or `0`, `false`, `no`) turns it off; it is on by default. */
export function prLensEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(?:0|off|false|no)$/i.test((env.AGENT_OFFICE_OPORA_PR_LENS ?? '').trim());
}

/** The worker's instruction, appended to its execution prompt while the feature is on. */
export function prLensInstructions(): string {
  return `Before submitting a code change, draw it with PR Lens (optional review evidence; skip it if the CLI won't run, never let it block the result). Read the format once with \`${PR_LENS_NPX} skill\`, write the graph document of your diff against the base to ${PR_LENS_GRAPH}, run \`${PR_LENS_NPX} validate ${PR_LENS_GRAPH}\` until it passes, then \`${PR_LENS_NPX} render ${PR_LENS_GRAPH} --theme light --out ${PR_LENS_RENDER}\`. Add \`.pr-lens/\` to the file \`git rev-parse --git-path info/exclude\` prints and never commit it. Never run \`analyze\`, \`canvas\` or \`auth\`: Office attaches the diagram to the pull request itself. Reviewers and the next agents read your validated spec (${PR_LENS_RENDER}/drawn.graph.json) instead of screenshots, so make card names exact and give each card its real file paths and line ranges; put naming fixes in .github/pr-lens.yml, not in the SVG.`;
}

export interface LensDiagram { file: string; svg: string; alt: string; validatedAt: string;
  /** The drawn graph document the pictures show, as the CLI wrote it, with its SHA-256 and size. */
  spec: { text: string; sha256: string; bytes: number } }

/**
 * The diagram to attach from the worker's render, or undefined: the manifest the CLI wrote (it only
 * renders a document that validates), its top view (architecture overview first), and that SVG
 * checked to be the self-contained, script-free picture PR Lens draws.
 */
export function findLensDiagram(dir: string): LensDiagram | undefined {
  const render = path.join(dir, PR_LENS_RENDER);
  const manifestFile = path.join(render, 'manifest.json');
  let manifest: { kind?: unknown; assets?: unknown };
  let validatedAt: string;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest;
    validatedAt = statSync(manifestFile).mtime.toISOString();
  } catch { return undefined; }
  if (manifest.kind !== 'render-manifest' || !Array.isArray(manifest.assets)) return undefined;
  const assets = manifest.assets.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object'
    && typeof (a as Record<string, unknown>).path === 'string' && SVG_FILE.test((a as Record<string, string>).path)
    && (a as Record<string, unknown>).mediaType === 'image/svg+xml');
  const top = assets.find((a) => a.lens === 'architecture' && a.view === 'overview') ?? assets.find((a) => a.lens === 'architecture') ?? assets[0];
  if (!top) return undefined;
  const file = top.path as string;
  const svg = path.join(render, file);
  try {
    if (statSync(svg).size > MAX_SVG) return undefined;
    const text = readFileSync(svg, 'utf8');
    if (!/<svg[\s>]/.test(text) || UNSAFE.test(text)) return undefined;
  } catch { return undefined; }
  let title = '', spec: LensDiagram['spec'];
  try {
    const text = readFileSync(path.join(render, 'drawn.graph.json'), 'utf8');
    const drawn = JSON.parse(text) as { kind?: unknown; title?: unknown };
    const bytes = Buffer.byteLength(text);
    if (drawn.kind !== 'graph' || bytes > MAX_SPEC) return undefined;
    if (typeof drawn.title === 'string') title = drawn.title;
    spec = { text, bytes, sha256: createHash('sha256').update(text).digest('hex') };
  } catch { return undefined; }
  const what = `${String(top.lens ?? 'diagram')} · ${String(top.view ?? file)}`;
  const alt = `PR Lens ${what}${title ? `: ${title}` : ''}`.replace(/[[\]()\s]+/g, ' ').trim().slice(0, 200);
  return { file, svg, alt, validatedAt, spec };
}

/** The side branch a head branch's diagrams go on, so the pull request's own diff never carries them. */
export const lensBranch = (branch: string) => `pr-lens/${branch}`;
export const lensPath = (file: string) => `.pr-lens/${file}`;
/** A link GitHub serves to anyone who can read the repository (private ones included, signed in). */
export const lensUrl = (repository: string, commit: string, file: string) => `https://github.com/${repository}/raw/${commit}/${lensPath(file)}`;

/** The `gh` argument lists (no shell): point the side branch at the head, then put the spec and the SVG on it. */
export function lensGhArgs(repository: string, branch: string, headSha: string, file: string, inputFile: string) {
  const side = lensBranch(branch);
  return {
    createRef: ['api', '-X', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/heads/${side}`, '-f', `sha=${headSha}`],
    moveRef: ['api', '-X', 'PATCH', `repos/${repository}/git/refs/heads/${side}`, '-f', `sha=${headSha}`, '-F', 'force=true'],
    putSpec: ['api', '-X', 'PUT', `repos/${repository}/contents/${lensPath(LENS_SPEC_FILE)}`, '--input', inputFile],
    put: ['api', '-X', 'PUT', `repos/${repository}/contents/${lensPath(file)}`, '--input', inputFile],
  };
}

/** The pull request's PR Lens section. */
export function lensMarkdown(diagram: LensDiagram, url: string, specUrl: string): string {
  return `## PR Lens\n\n![${diagram.alt}](${url})\n\n<sub>Drawn by the worker that made the change and validated locally with PR Lens. Agents read the [spec](${specUrl}) (lanes, cards with files and lines, flows, payloads), not the picture. Optional review evidence; name fixes go in \`.github/pr-lens.yml\`.</sub>`;
}

/** The body with the PR Lens section before its trailer block (Canvas reads the trailers at the end). */
export function withLensSection(body: string, section: string): string {
  const at = body.lastIndexOf('\n\n---\n\n');
  return at < 0 ? `${body}\n\n${section}` : `${body.slice(0, at)}\n\n${section}${body.slice(at)}`;
}

export interface LensEvidence {
  url: string; prNumber: number; headSha: string; validatedAt: string;
  /** Where the validated spec is (the side branch commit), its SHA-256 and size, and the spec itself when it's at most 64 KiB. */
  specUrl: string; specSha256: string; specBytes: number; spec?: unknown;
}
export type LensOutcome = 'recorded' | 'not-deployed' | 'conflict' | 'failed';

/** POST /api/oporahub/review-jobs/lens as the office's agent. 404: Canvas doesn't take it yet, which is fine. */
export async function postLens(base: string, agent: string, transport: typeof fetch,
  body: { project: string; workspace: string; executionId: string; lens: LensEvidence }): Promise<LensOutcome> {
  try {
    const response = await transport(new URL('/api/oporahub/review-jobs/lens', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(base).origin, 'X-Opora-Actor': `agent; name=${agent}` },
      body: JSON.stringify(body),
    });
    if (response.ok) return 'recorded';
    return response.status === 404 ? 'not-deployed' : response.status === 409 ? 'conflict' : 'failed';
  } catch { return 'failed'; }
}

export function lensEvent(lease: Pick<ExecutionLease, 'project' | 'workspace' | 'nodeId' | 'executionId'>, lens: LensEvidence, outcome: LensOutcome): ProcessInput {
  return {
    kind: 'pr.lens', phase: 'review', state: 'ok',
    title: `PR Lens diagram u PR #${lens.prNumber}`,
    detail: `head ${lens.headSha.slice(0, 12)} · Canvas: ${outcome}`,
    refs: { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, sha: lens.headSha, pr: lens.prNumber, url: lens.url },
  };
}

/** What the attachment runs, the same narrow git/gh/Canvas the handoff fakes in tests. */
export interface LensTools { gh(args: string[], cwd: string): Promise<string>; transport: typeof fetch; env: NodeJS.ProcessEnv }
export interface PreparedLens { diagram: LensDiagram; url: string; specUrl: string; markdown: string }

/** The handoff's PR Lens step. Every failure here is swallowed: a diagram is evidence, never a gate. */
export class PrLensAttachment {
  constructor(private scratch: string, private base: string, private agent: string, private tools: LensTools) {}

  /** Publishes the worker's diagram for this head on its side branch; undefined when off, absent, or it couldn't. */
  async prepare(dir: string, at: { repository: string; branch: string; headSha: string; executionId: string }): Promise<PreparedLens | undefined> {
    if (!prLensEnabled(this.tools.env) || !SHA.test(at.headSha)) return undefined;
    const diagram = findLensDiagram(dir);
    if (!diagram) return undefined;
    const input = path.join(this.scratch, `${at.executionId.replace(/[^A-Za-z0-9._-]/g, '_')}-lens-upload.json`);
    const args = lensGhArgs(at.repository, at.branch, at.headSha, diagram.file, input);
    try {
      const upload = async (what: string, content: Buffer, put: string[]) => {
        writeFileSync(input, JSON.stringify({ message: `PR Lens ${what} for ${at.headSha.slice(0, 12)}`, branch: lensBranch(at.branch), content: content.toString('base64') }), { mode: 0o600 });
        return JSON.parse(await this.tools.gh(put, dir)) as { commit?: { sha?: unknown } };
      };
      await this.tools.gh(args.createRef, dir).catch(() => this.tools.gh(args.moveRef, dir));
      await upload('spec', Buffer.from(diagram.spec.text), args.putSpec);
      const put = await upload('diagram', readFileSync(diagram.svg), args.put);
      const commit = put.commit?.sha;
      if (typeof commit !== 'string' || !SHA.test(commit)) return undefined;
      const url = lensUrl(at.repository, commit, diagram.file), specUrl = lensUrl(at.repository, commit, LENS_SPEC_FILE);
      return { diagram, url, specUrl, markdown: lensMarkdown(diagram, url, specUrl) };
    } catch { return undefined; } finally { rmSync(input, { force: true }); }
  }

  /** On a pull request that already existed, the diagram goes in a comment instead of the body. */
  async comment(repository: string, number: number, lens: PreparedLens, dir: string): Promise<void> {
    await this.tools.gh(['pr', 'comment', String(number), '--repo', repository, '--body', lens.markdown], dir).catch(() => undefined);
  }

  /** Tells Canvas (optional evidence) and the process journal where the diagram is. */
  async report(lease: ExecutionLease, pr: { number: number; headSha: string }, lens: PreparedLens): Promise<LensOutcome> {
    const { spec } = lens.diagram;
    const evidence: LensEvidence = { url: lens.url, prNumber: pr.number, headSha: pr.headSha, validatedAt: lens.diagram.validatedAt,
      specUrl: lens.specUrl, specSha256: spec.sha256, specBytes: spec.bytes, ...(spec.bytes <= MAX_INLINE_SPEC ? { spec: JSON.parse(spec.text) as unknown } : {}) };
    const outcome = await postLens(this.base, this.agent, this.tools.transport, { project: lease.project, workspace: lease.workspace, executionId: lease.executionId, lens: evidence });
    emitProcess(this.agent, lensEvent(lease, evidence, outcome));
    return outcome;
  }
}
