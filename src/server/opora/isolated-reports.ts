import { createHash } from 'node:crypto';
import { ManagedAgentsHttp } from './executors/managed-http.js';
import { ExecutorFailure, type ExecutionIntent } from './executors/types.js';
import { digest, object, validateIntent } from './executors/validation.js';
import { commitsFromPatch, withStepCommits, type PlanStep, type StepCommits } from './plan-steps.js';

export type ReportJson = null | boolean | number | string | ReportJson[] | { [key: string]: ReportJson };
export interface RemoteReportedResult {
  eventId: string; processedAt: string; result: { summary: string; [key: string]: ReportJson };
  requestId: string; digest: string;
}
const KEYS = ['schemaVersion', 'kind', 'intentId', 'executionId', 'epoch', 'acceptedRevision', 'assignmentDigest', 'result'];

/** Public immutable task identity only; secrets and worker capabilities are never prompt data. */
export function remoteReportInstructions(input: ExecutionIntent): string {
  const intent = validateIntent(input);
  const envelope = { schemaVersion: 1, kind: 'oporahub-reported-result', intentId: intent.intentId,
    executionId: intent.executionId, epoch: intent.epoch, acceptedRevision: intent.acceptedRevision,
    assignmentDigest: intent.assignmentDigest, result: { summary: 'Describe the actual outcome here.' } };
  return 'Finish with one agent message containing ONLY this JSON envelope, without Markdown or surrounding prose. '
    + 'Keep the exact identity fields. Replace result.summary with a nonempty outcome (at most 8000 characters); '
    + 'result may contain additional JSON evidence. The entire message must fit 64000 UTF-8 bytes. '
    + 'This is your reported outcome, not independent verification, provider usage, isolation proof, or permission to complete a Canvas card.\n'
    + JSON.stringify(envelope);
}

function parse(text: string): unknown {
  // Normalize one whole JSON fence only; never extract a report from prose.
  const fenced = /^\s*```json\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text);
  if (fenced) text = fenced[1];
  // JSON.parse alone silently overwrites duplicate keys. Scan containers first,
  // respecting escaped strings; JSON.parse still owns all syntax validation.
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g) ?? []) {
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? { keys: new Set(), key: true } : null);
      if (stack.length > 32) throw new ExecutorFailure();
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)) stack.at(-1)!.key = true;
    else if (token === ':' && stack.at(-1)) stack.at(-1)!.key = false;
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const parent = stack.at(-1)!;
      let key: string; try { key = JSON.parse(token); } catch { return null; }
      if (parent.keys.has(key)) throw new ExecutorFailure();
      parent.keys.add(key); parent.key = false;
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

function safe(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return Buffer.from(value).toString('utf8') === value;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(item => safe(item, depth + 1));
  return object(value) && Object.entries(value).every(([key, item]) => safe(key, depth + 1) && safe(item, depth + 1));
}

/** Provider GET attests message provenance only. Its contents remain an untrusted agent claim. */
export async function readRemoteReport(http: ManagedAgentsHttp, input: ExecutionIntent, sessionId: string,
  steps: PlanStep[] = []): Promise<RemoteReportedResult | null> {
  const intent = validateIntent(input);
  const message = await http.readLatestMessage(sessionId);
  if (!message) return null;
  const report = parse(message.text);
  if (!object(report) || report.kind !== 'oporahub-reported-result') return null;
  if (Object.keys(report).length !== KEYS.length || !KEYS.every(key => key in report) || report.schemaVersion !== 1
    || !['intentId', 'executionId', 'epoch', 'acceptedRevision', 'assignmentDigest'].every(key => report[key] === intent[key as keyof ExecutionIntent])
    || !object(report.result) || !safe(report.result) || typeof report.result.summary !== 'string'
    || !report.result.summary.trim() || report.result.summary.length > 8000) throw new ExecutorFailure();
  const result = remoteStepResults(structuredClone(report.result) as RemoteReportedResult['result'], steps);
  return seal(intent, sessionId, message.eventId, message.processedAt, result);
}

function seal(intent: ExecutionIntent, sessionId: string, eventId: string, processedAt: string, result: RemoteReportedResult['result']): RemoteReportedResult {
  const body = { eventId, processedAt, result };
  const requestId = createHash('sha256').update(intent.intentId + sessionId + eventId).digest('hex');
  return { ...body, requestId, digest: digest({ ...body, intentId: intent.intentId, executionId: intent.executionId,
    epoch: intent.epoch, acceptedRevision: intent.acceptedRevision, assignmentDigest: intent.assignmentDigest, sessionId }) };
}

/**
 * The report as Canvas gets it once the office has replayed the patch (isolated-pull-request.ts): each
 * step's commits are the replayed ones, the SHAs the pull request branch carries, never the container's.
 * Without a replay (no patch, no pull request, a patch that doesn't apply) the steps keep no commits,
 * since the container's SHAs exist nowhere Canvas or a reviewer could look them up. Same requestId, new digest.
 */
export function withReplayedCommits(report: RemoteReportedResult, intent: ExecutionIntent, sessionId: string,
  steps: PlanStep[], replayed: StepCommits | undefined): RemoteReportedResult {
  if (!steps.length || !('stepResults' in report.result)) return report;
  const result = remoteStepResults(structuredClone(report.result), steps, replayed ?? new Map());
  return seal(intent, sessionId, report.eventId, report.processedAt, result);
}

/**
 * Plan steps on the isolated path: each step's commits come from git, never from the agent (by default
 * the patch's own `From <sha>` / `Subject: step <id>:` lines; withReplayedCommits passes the replayed ones); stepResults Canvas would refuse (or any, for a
 * card without pinned steps) are left out, so the rest of the result still goes through.
 */
export function remoteStepResults(result: RemoteReportedResult['result'], steps: PlanStep[],
  commits: StepCommits = commitsFromPatch(typeof result.patch === 'string' ? result.patch : '', steps)): RemoteReportedResult['result'] {
  if (!('stepResults' in result)) return result;
  const checked = withStepCommits(result, steps, commits);
  if (!checked.problem) return checked.result as RemoteReportedResult['result'];
  const { stepResults: _refused, ...rest } = result;
  return rest as RemoteReportedResult['result'];
}
