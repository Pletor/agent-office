import { spawn } from 'node:child_process';
import type { ResolveRun } from './upkeep-tools.js';

/**
 * The LLM fallback of PR upkeep (pr-upkeep.ts): a new `claude -p` process for each conflicted rebase
 * step, the same headless launch as the review workers' (review-agent.ts). It keeps no session
 * (`--no-session-persistence`), loads none of the user's or the project's settings, hooks, MCP
 * servers or plugins, and gets file tools only (no shell), with edits accepted inside its working
 * directory, the throwaway worktree, and nowhere else. Git itself (add, continue, push) stays with
 * the office, and nothing it writes is pushed before the check command passes.
 */

export const RESOLVE_TOOLS = 'Read,Edit,Write,Grep,Glob';

export const RESOLVE_SYSTEM = [
  'You resolve git merge conflicts left by a rebase, in the current directory only.',
  'Edit each listed file so it keeps the intent of both sides: the base branch\'s change and the pull request\'s change.',
  'Remove every conflict marker (<<<<<<<, =======, >>>>>>>). Do not touch files that are not listed.',
  'Do not run git or any other command. When finished, answer with one short line saying what you kept from each side.',
].join(' ');

export function resolveArgs(model?: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--system-prompt', RESOLVE_SYSTEM,
    '--tools', RESOLVE_TOOLS,
    '--permission-mode', 'acceptEdits',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
}

export function resolvePrompt(pr: { number: number; title?: string; baseRefName: string }, baseSha: string, files: string[]): string {
  return [
    `Pull request #${pr.number}${pr.title ? ` (${pr.title})` : ''} is being rebased onto ${pr.baseRefName} at ${baseSha}.`,
    'git stopped on textual conflicts in these files:',
    ...files.map((f) => `- ${f}`),
    'Resolve them now.',
  ].join('\n');
}

export function claudeResolver(claude: string, env: Record<string, string>, timeoutMs: number, model?: string) {
  return headlessClaude(claude, env, timeoutMs, resolveArgs(model));
}

/** One fresh `claude -p` run with `args` in the run's directory, the prompt on stdin; resolves to its answer. */
export function headlessClaude(claude: string, env: Record<string, string>, timeoutMs: number, args: string[]) {
  return ({ cwd, prompt }: ResolveRun): Promise<string> => new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const child = spawn(claude, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      try {
        const res = JSON.parse(out) as { is_error?: boolean; result?: unknown };
        if (res?.is_error) throw new Error('the headless run reported an error');
        resolve(typeof res?.result === 'string' ? res.result : '');
      } catch (e) { reject(e as Error); }
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('the headless run timed out')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { if (out.length < 4 * 1024 * 1024) out += d; });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(code === 0 ? undefined : new Error(`claude exited with ${code}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
