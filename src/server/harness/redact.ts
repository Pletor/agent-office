// Secret redaction for anything a run snapshot embeds or hands a worker (docs/harness.md "Run snapshot
// and lazy reads"). It is a scan for obvious secret shapes, not a secret scanner: a match is replaced
// with `[redacted:<kind>]` and only the kind and how often it matched are recorded, never the value.
// The credential-like filename rule (catalog.ts) keeps such files out of the library in the first place.

/** What a scan found in one text: each kind with how many times it matched. Values are never kept. */
export type RedactionCounts = Record<string, number>;

/** One pattern: what it is called in `[redacted:<kind>]`, and how to find it. `keep` is a leading group kept as written (the `password=` of an assignment). */
interface Pattern { kind: string; re: RegExp; keep?: boolean }

// Values an assignment may hold without being a secret: placeholders and references to one kept elsewhere.
const PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]*\}\}|\*+|x+|\.\.\.|…|\[redacted:[a-z-]+\])$/i;

const PATTERNS: readonly Pattern[] = [
  // A whole PEM private key block, header to footer (RSA, EC, OPENSSH, ENCRYPTED, plain PRIVATE KEY).
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  // A header without its footer is still a key cut short: everything to the end of the text goes.
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*$/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: 'api-key', re: /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{20,}/g },
  { kind: 'bearer-token', re: /(\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{16,}/g, keep: true },
  // `password=...`, `API_KEY: "..."`, `token = '...'`: the name is kept, a value of 8 characters or more goes.
  { kind: 'credential-assignment', re: /(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)("[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"',;]{8,})/gi, keep: true },
];

/** Replaces every match of the patterns with `[redacted:<kind>]` and counts the kinds; the values are dropped, never returned. */
export function redactSecrets(text: string): { text: string; found: RedactionCounts } {
  const found: RedactionCounts = {};
  let out = text;
  for (const { kind, re, keep } of PATTERNS) {
    out = out.replace(re, (match: string, lead?: unknown, value?: unknown) => {
      if (keep && typeof value === 'string' && PLACEHOLDER.test(value.replace(/^["']|["']$/g, ''))) return match;
      found[kind] = (found[kind] ?? 0) + 1;
      // A quoted value keeps its quotes, so the text around it still parses.
      const quote = typeof value === 'string' && /^["']/.test(value) ? value[0] : '';
      return (keep && typeof lead === 'string' ? lead : '') + quote + '[redacted:' + kind + ']' + quote;
    });
  }
  return { text: out, found };
}

/** Whether any pattern still matches: a redacted text must come back clean, or it is not handed out. */
export function hasSecrets(text: string): boolean {
  return Object.keys(redactSecrets(text).found).length > 0;
}

/** Adds one text's counts into a running total. */
export function addCounts(into: RedactionCounts, from: RedactionCounts): RedactionCounts {
  for (const [kind, n] of Object.entries(from)) into[kind] = (into[kind] ?? 0) + n;
  return into;
}
