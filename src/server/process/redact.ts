// What may leave the office in a process event: no tokens, lease tokens, passwords, prompt text or
// absolute paths into the office's data. Every string an event carries goes through here.

import os from 'node:os';

const SECRETS: [RegExp, string][] = [
  // GitHub, Anthropic/OpenAI style and Slack tokens.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, '[skryto]'],
  // Authorization headers.
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [skryto]'],
  // key=value / key: value for anything that names a secret (token, leaseToken, password, secret, api key…).
  [/\b([A-Za-z_-]*(?:token|password|passwd|secret|api[_-]?key|apikey|credential)[A-Za-z_-]*)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1$2[skryto]'],
  // Credentials in a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[skryto]@'],
  // Long hex/base64 blobs that look like keys (a 40-hex SHA stays: it's a commit).
  [/\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{64,}={0,2}/g, '[skryto]'],
];

/** Paths the office keeps its own data under: anything inside one of these is hidden. */
const DATA_PATH = /(?:[A-Za-z]:)?[\\/][^\s"'`]*?[\\/]\.agent-office(?:[\\/][^\s"'`]*)?/g;

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Hides secrets and data-dir paths, folds a root (the floor's checkout, the home folder) to a short name, and cuts to `max`. */
export function redact(text: unknown, max: number, roots: string[] = []): string {
  let s = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  for (const [re, to] of SECRETS) s = s.replace(re, to);
  s = s.replace(DATA_PATH, '[data]');
  for (const root of [...roots, os.homedir()].filter((r) => r && r.length > 3)) {
    // Either slash, any case on Windows.
    const pattern = escape(root).replace(/\\\\|\//g, '[\\\\/]');
    s = s.replace(new RegExp(pattern, process.platform === 'win32' ? 'gi' : 'g'), root === os.homedir() ? '~' : '.');
  }
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
