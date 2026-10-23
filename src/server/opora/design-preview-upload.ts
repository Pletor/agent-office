// A design card's screenshots as Opora's `evidence.preview` (Opora docs/design-nahled.md §4), so a person
// can "Potvrdit vzhled" on the card. The worker writes them, with a preview.json, to
// `<dataDir>/opora-previews/<project>/<card>/<head SHA>/` (design-brief.ts); once the handoff has linked
// the execution's pull request, the office reads that folder for the PR's head, checks it against
// Opora's contract and sends it to `POST /api/oporahub/review-jobs/preview` with the execution's lease
// token and epoch. No folder or no preview.json: nothing happens. An unusable one, a refusal or an
// unreachable Opora is logged and shown on the process wall like the PR Lens; it never blocks the PR.
// The token is only ever in the request body: never in a log line, a process event or the PR.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProcessInput } from '../process/journal.js';
import { emitProcess } from '../process/hub.js';
import { MAX_PREVIEWS, previewFolder } from './design-brief.js';
import type { ExecutionLease } from './execution-client.js';

/** Opora's limits (opora_design_preview_validation.py and the route's MAX_BODY). */
export const MAX_PNG_BYTES = 2 * 1024 * 1024;
export const MAX_PROPOSAL_BYTES = 64 * 1024;
export const MAX_BODY = 23 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const SHA = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
/** 1–60 printable characters without outer spaces (Opora's label and stage). */
const TEXT = /^[^\u0000-\u001f\u007f]{1,60}$/;
/** A screenshot is a plain PNG file name next to preview.json, never a path. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.png$/i;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface PreviewShot { label: string; viewport: { width: number; height: number }; stage?: string; dataURL: string }
export interface PreviewEvidence { prNumber: number; headSha: string; designMdSha256: string | null; proposedDesignMd?: string; screenshots: PreviewShot[] }
export type PreviewRead = { state: 'absent' } | { state: 'invalid'; reason: string } | { state: 'ready'; preview: PreviewEvidence; bytes: number };

class Invalid extends Error {}
const fail = (reason: string): never => { throw new Invalid(reason); };

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TEXT.test(value) || value !== value.trim()) fail(`${name} must be 1–60 printable characters without outer spaces`);
  return value as string;
}

function viewport(value: unknown): { width: number; height: number } {
  if (!isObject(value) || Object.keys(value).sort().join() !== 'height,width') fail('viewport must be {width, height}');
  const v = value as Json;
  for (const [key, top] of [['width', 8000], ['height', 20000]] as const) {
    if (!Number.isInteger(v[key]) || (v[key] as number) < 120 || (v[key] as number) > top) fail(`viewport.${key} must be an integer between 120 and ${top}`);
  }
  return { width: v.width as number, height: v.height as number };
}

function png(folder: string, file: unknown): string {
  if (typeof file !== 'string' || !FILE.test(file) || file.includes('..')) fail('a screenshot file must be a .png name next to preview.json');
  const at = path.join(folder, file as string);
  let stat;
  try { stat = lstatSync(at); } catch { return fail(`${file} is missing`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${file} is not a plain file`);
  if (stat.size > MAX_PNG_BYTES) fail(`${file} is over ${MAX_PNG_BYTES} bytes`);
  const data = readFileSync(at);
  if (data.length > MAX_PNG_BYTES || !data.subarray(0, 8).equals(PNG)) fail(`${file} is not a PNG of at most ${MAX_PNG_BYTES} bytes`);
  return `data:image/png;base64,${data.toString('base64')}`;
}

/** The proposed DESIGN.md the worker committed, read from the head commit (never the working tree). */
async function proposal(value: unknown, at: { dir: string; headSha: string; git: PreviewTools['git'] }): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value) || /[\u0000-\u001f:]/.test(value)) {
    return fail('proposedDesignMd must be a path inside the repository');
  }
  let markdown: string;
  try { markdown = await at.git(['show', `${at.headSha}:${value.replace(/\\/g, '/')}`], at.dir); } catch { return fail(`proposedDesignMd ${value} is not in the head commit`); }
  if (!markdown.trim() || Buffer.byteLength(markdown, 'utf8') > MAX_PROPOSAL_BYTES) fail(`proposedDesignMd must be nonempty Markdown of at most ${MAX_PROPOSAL_BYTES} bytes`);
  return markdown;
}

/** The worker's preview for this head, checked against Opora's contract; `absent` when there is no preview.json. */
export async function readPreview(dataDir: string, lease: Pick<ExecutionLease, 'project' | 'nodeId'>,
  pr: { number: number; headSha: string }, repo: { dir: string; git: PreviewTools['git'] }): Promise<PreviewRead> {
  if (!SHA.test(pr.headSha)) return { state: 'absent' };
  const folder = path.join(previewFolder(dataDir, lease.project, lease.nodeId), pr.headSha);
  const manifest = path.join(folder, 'preview.json');
  try {
    const stat = lstatSync(manifest);
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'invalid', reason: 'preview.json is not a plain file' };
    if (stat.size > MAX_MANIFEST) return { state: 'invalid', reason: `preview.json is over ${MAX_MANIFEST} bytes` };
  } catch { return { state: 'absent' }; }
  try {
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return fail('preview.json is not JSON'); }
    if (!isObject(doc)) fail('preview.json must be an object');
    const d = doc as Json;
    if (d.headSha !== pr.headSha) fail('preview.json is for another head commit');
    const design = d.designMdSha256 ?? null;
    if (design !== null && (typeof design !== 'string' || !SHA256.test(design))) fail('designMdSha256 must be a sha256 hex digest or null');
    const shots = d.screenshots;
    if (!Array.isArray(shots) || shots.length < 1 || shots.length > MAX_PREVIEWS) fail(`screenshots must hold 1–${MAX_PREVIEWS} entries`);
    const screenshots: PreviewShot[] = [];
    for (const item of shots as unknown[]) {
      if (!isObject(item)) fail('each screenshot must be an object');
      const s = item as Json, label = text(s.label, 'label');
      if (screenshots.some(other => other.label === label)) fail('screenshot labels must be unique');
      const stage = s.stage === undefined || s.stage === null ? undefined : text(s.stage, 'stage');
      screenshots.push({ label, viewport: viewport(s.viewport), ...(stage ? { stage } : {}), dataURL: png(folder, s.file) });
    }
    const proposed = await proposal(d.proposedDesignMd, { ...repo, headSha: pr.headSha });
    const preview: PreviewEvidence = { prNumber: pr.number, headSha: pr.headSha, designMdSha256: design as string | null,
      ...(proposed !== undefined ? { proposedDesignMd: proposed } : {}), screenshots };
    const bytes = Buffer.byteLength(JSON.stringify(preview));
    if (bytes > MAX_BODY - 4096) fail(`the preview is ${bytes} bytes, over Opora's ${MAX_BODY}`);
    return { state: 'ready', preview, bytes };
  } catch (error) {
    if (error instanceof Invalid) return { state: 'invalid', reason: error.message };
    throw error;
  }
}

export type PreviewOutcome = 'recorded' | 'not-deployed' | 'conflict' | 'failed';
export interface PreviewReply { outcome: PreviewOutcome; reason?: string }

/** Opora's `{error}` text or the transport's message as one short line, with the token taken out should it ever appear. */
const reasonText = (v: unknown, token: string): string => {
  let t = (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (token) t = t.split(token).join('[redacted]');
  return t.slice(0, 160);
};

/** POST /api/oporahub/review-jobs/preview as the office's agent, with the execution's credentials. 404: Opora doesn't take it yet. */
export async function postPreview(base: string, agent: string, transport: typeof fetch, lease: ExecutionLease, preview: PreviewEvidence): Promise<PreviewReply> {
  try {
    const response = await transport(new URL('/api/oporahub/review-jobs/preview', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(base).origin, 'X-Opora-Actor': `agent; name=${agent}` },
      body: JSON.stringify({ project: lease.project, workspace: lease.workspace, executionId: lease.executionId, token: lease.token, epoch: lease.epoch, preview }),
    });
    if (response.ok) return { outcome: 'recorded' };
    const outcome: PreviewOutcome = response.status === 404 ? 'not-deployed' : response.status === 409 ? 'conflict' : 'failed';
    const said = await response.json().then((b: unknown) => (isObject(b) ? reasonText(b.error, lease.token) : ''), () => '');
    return { outcome, reason: `HTTP ${response.status}${said ? `: ${said}` : ''}` };
  } catch (error) { return { outcome: 'failed', reason: reasonText((error as Error).message, lease.token) || 'unreachable' }; }
}

export function previewEvent(lease: Pick<ExecutionLease, 'project' | 'workspace' | 'nodeId' | 'executionId'>, pr: { number: number; headSha: string },
  outcome: PreviewOutcome | 'invalid', detail: string): ProcessInput {
  const failed = outcome === 'conflict' || outcome === 'failed' || outcome === 'invalid';
  return {
    kind: 'design.preview', phase: 'review', state: failed ? 'fail' : outcome === 'not-deployed' ? 'info' : 'ok',
    title: `Náhled design karty u PR #${pr.number}${failed ? ' se neuložil' : ''}`,
    detail: `head ${pr.headSha.slice(0, 12)} · ${detail}`.slice(0, 240),
    refs: { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, sha: pr.headSha, pr: pr.number },
  };
}

/** How long after a 409 the office tries once more (Opora may not have caught up with the PR link yet). */
export const PREVIEW_RETRY_MS = 60_000;
const retryLater = (run: () => void) => { setTimeout(run, PREVIEW_RETRY_MS).unref(); };

export interface PreviewTools { git(args: string[], cwd: string): Promise<string>; transport: typeof fetch; later?: (run: () => void) => void }
type Log = (message: string, level: 'info' | 'warn' | 'error') => void;

/** The handoff's design-preview step, after the PR is linked. Evidence, never a gate: a failure is logged, not thrown. */
export class DesignPreviewAttachment {
  constructor(private dataDir: string, private base: string, private agent: string, private tools: PreviewTools) {}

  async report(lease: ExecutionLease, pr: { number: number; headSha: string }, dir: string, log: Log = () => {}): Promise<PreviewOutcome | 'absent' | 'invalid'> {
    const read = await readPreview(this.dataDir, lease, pr, { dir, git: this.tools.git });
    if (read.state === 'absent') return 'absent';
    if (read.state === 'invalid') {
      emitProcess(this.agent, previewEvent(lease, pr, 'invalid', `preview.json: ${read.reason}`));
      log(`🛰️ Design preview for ${lease.executionId} (PR #${pr.number}) not sent: ${read.reason}`, 'warn');
      return 'invalid';
    }
    const outcome = await this.send(lease, pr, read.preview, log, false);
    if (outcome === 'conflict') (this.tools.later ?? retryLater)(() => { void this.send(lease, pr, read.preview, log, true); });
    return outcome;
  }

  private async send(lease: ExecutionLease, pr: { number: number; headSha: string }, preview: PreviewEvidence, log: Log, retry: boolean): Promise<PreviewOutcome> {
    const { outcome, reason } = await postPreview(this.base, this.agent, this.tools.transport, lease, preview);
    emitProcess(this.agent, previewEvent(lease, pr, outcome, `${preview.screenshots.length} screenshots · Opora: ${outcome}${reason ? ` (${reason})` : ''}`));
    if (outcome === 'conflict' || outcome === 'failed') {
      const next = outcome === 'conflict' && !retry ? '; trying once more later' : '';
      log(`🛰️ Design preview for ${lease.executionId} (PR #${pr.number})${retry ? ' on retry' : ''} wasn't stored by Opora: ${outcome} (${reason ?? 'no reason'})${next}`, 'warn');
    } else if (retry) log(`🛰️ Design preview for ${lease.executionId} (PR #${pr.number}) on retry: ${outcome}`, 'info');
    return outcome;
  }
}
