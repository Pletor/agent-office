import { spawn } from 'node:child_process';

/**
 * One review model run: a new `claude -p` process each time, the same headless launch the office
 * uses for its task namer and plan limits (tasks.ts, limits.ts). It never resumes or continues a
 * session and keeps none (`--no-session-persistence`), so every slot (and its one repair attempt)
 * starts from a fresh context. It gets read-only tools only, in the slot's checkout, and none of the
 * user's or the project's settings, hooks, MCP servers or plugins.
 */

export interface ReviewRun { cwd: string; system: string; prompt: string; signal: AbortSignal }
/** Resolves to the model's final answer text; rejects when the run fails, times out or is aborted. */
export type ReviewAgent = (run: ReviewRun) => Promise<string>;

export const REVIEW_TOOLS = 'Read,Grep,Glob';

export function claudeReviewArgs(system: string, model?: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--system-prompt', system,
    '--tools', REVIEW_TOOLS,
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
}

/** The final text of `--output-format json`'s envelope. */
export function envelopeText(out: string): string {
  const res = JSON.parse(out) as { is_error?: boolean; result?: unknown; structured_output?: unknown };
  if (res?.is_error) throw new Error('the review model reported an error');
  if (typeof res?.result !== 'string') throw new Error('the review model returned no answer');
  return res.result;
}

export function claudeReviewAgent(claude: string, env: Record<string, string>, timeoutMs: number, model?: string): ReviewAgent {
  return ({ cwd, system, prompt, signal }) => new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const child = spawn(claude, claudeReviewArgs(system, model), { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) return reject(error);
      try { resolve(envelopeText(out)); } catch (e) { reject(e as Error); }
    };
    const abort = () => { child.kill('SIGKILL'); finish(new Error('review run aborted')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('review run timed out')); }, timeoutMs);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { if (out.length < 8 * 1024 * 1024) out += d; });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(code === 0 ? undefined : new Error(`claude exited with ${code}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
