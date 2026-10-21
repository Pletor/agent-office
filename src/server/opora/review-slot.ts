import { createHash } from 'node:crypto';
import { ReviewJobError, type ReviewAssignment, type ReviewJobClient, type ReviewScope } from './review-client.js';
import type { ReviewAgent } from './review-agent.js';
import type { Checkout } from './review-checkout.js';
import { checkFinder, checkVoter, parseAnswer, type Checked, type FinderSubmission, type VoterSubmission } from './review-output.js';
import { reviewPrompts, type ReviewPrompts } from './review-kinds.js';
import { finderPrompt, repairPrompt, voterPrompt } from './review-prompt.js';

/**
 * One claimed review slot, start to finish: its own checkout, a fresh model run (and at most one
 * fresh repair run), the answer checked in code, and the submission. A heartbeat every third of the
 * lease keeps the slot while it works; losing the lease aborts the run without submitting, and any
 * other failure releases the slot for another worker. Submitting is idempotent: the request id is
 * derived from the slot and its epoch, so a retry after a lost answer replays the same receipt.
 */

export type SlotOutcome = 'submitted' | 'released' | 'lost';
export interface SlotDeps {
  client: ReviewJobClient;
  agent: ReviewAgent;
  checkout(a: ReviewAssignment): Promise<Checkout>;
  ttlSeconds: number;
  log(message: string, level: 'info' | 'warn'): void;
  /** Milliseconds between heartbeats, defaults to a third of the lease. */
  heartbeatMs?: number;
}

/** `[A-Za-z0-9_-]{1,80}`: the same for the same slot and epoch, so a retried submit replays. */
export function submitRequestId(a: Pick<ReviewAssignment, 'reviewJobId' | 'taskId' | 'epoch'>): string {
  return 'rs-' + createHash('sha256').update(`${a.reviewJobId}\n${a.taskId}\n${a.epoch}`).digest('hex').slice(0, 48);
}

type Answer = Checked<FinderSubmission> | Checked<VoterSubmission>;

function check(a: ReviewAssignment, text: string, prompts: ReviewPrompts): Answer {
  let raw: unknown;
  try { raw = parseAnswer(text); } catch (error) { return { ok: false, errors: [`not valid JSON: ${(error as Error).message.slice(0, 200)}`] }; }
  return a.role === 'finder' ? checkFinder(raw, a.knownFindings, prompts.fingerprintPrefix) : checkVoter(raw, a.candidates ?? []);
}

export async function runSlot(scope: ReviewScope, a: ReviewAssignment, deps: SlotDeps): Promise<SlotOutcome> {
  const label = `${a.job.repository}#${a.job.number}${a.job.kind === 'security' ? ' security' : ''} round ${a.job.round} ${a.role} slot ${a.slot}`;
  const abort = new AbortController();
  let lost = false;
  const beat = setInterval(() => {
    deps.client.heartbeat(scope, a, deps.ttlSeconds).catch((error: unknown) => {
      if (error instanceof ReviewJobError && error.transient) return;
      lost = true;
      abort.abort();
    });
  }, deps.heartbeatMs ?? Math.max(5_000, (deps.ttlSeconds * 1000) / 3));
  let checkout: Checkout | undefined;
  try {
    // An unknown kind is never reviewed with a guessed prompt: the slot goes back and the log says why.
    const prompts = reviewPrompts(a.job.kind);
    if (!prompts) throw new Error(`unknown review job kind ${JSON.stringify(String(a.job.kind).slice(0, 40))}; this office reviews only code and security jobs`);
    let submission: FinderSubmission | VoterSubmission;
    if (a.role === 'voter' && !(a.candidates ?? []).length) submission = { votes: [] };
    else {
      checkout = await deps.checkout(a);
      const system = a.role === 'finder' ? prompts.finder : prompts.voter;
      const prompt = a.role === 'finder' ? finderPrompt(a, checkout) : voterPrompt(a, checkout);
      const first = await deps.agent({ cwd: checkout.dir, system, prompt, signal: abort.signal });
      let answer = check(a, first, prompts);
      if (!answer.ok) {
        deps.log(`🔎 ${label}: the answer failed validation (${answer.errors.slice(0, 3).join('; ')}); one repair attempt`, 'warn');
        const second = await deps.agent({ cwd: checkout.dir, system, prompt: repairPrompt(prompt, first, answer.errors), signal: abort.signal });
        answer = check(a, second, prompts);
      }
      if (!answer.ok) throw new Error(`invalid answer after one repair (${answer.errors.slice(0, 3).join('; ')})`);
      submission = answer.value;
    }
    if (lost) return 'lost';
    const requestId = submitRequestId(a);
    for (let attempt = 1; ; attempt++) {
      try {
        const receipt = await deps.client.submit(scope, a, requestId, submission);
        deps.log(`🔎 ${label} submitted${receipt.phase ? ` (job now ${receipt.phase})` : ''}`, 'info');
        return 'submitted';
      } catch (error) {
        if (!(error instanceof ReviewJobError && error.transient) || attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  } catch (error) {
    if (lost) {
      deps.log(`🔎 ${label}: the lease was lost; nothing submitted`, 'warn');
      return 'lost';
    }
    deps.log(`🔎 ${label} released: ${(error as Error).message}`, 'warn');
    await deps.client.release(scope, a).catch(() => undefined);
    return 'released';
  } finally {
    clearInterval(beat);
    await checkout?.cleanup().catch(() => undefined);
  }
}
