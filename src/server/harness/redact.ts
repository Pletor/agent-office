// Secret redaction for anything a run snapshot embeds or hands a worker (docs/harness.md "Run snapshot
// and lazy reads"). It is a scan for obvious secret shapes, not a secret scanner: a match is replaced
// with `[redacted:<kind>]` and only the kind and how often it matched are recorded, never the value.
// The credential-like filename rule (catalog.ts) keeps such files out of the library in the first place.

/** What a scan found in one text: each kind with how many times it matched. Values are never kept. */
export type RedactionCounts = Record<string, number>;

/** One pattern: what it is called in `[redacted:<kind>]`, and how to find it. `keep` is a leading group kept as written (the `password=` of an assignment). */
interface Pattern { kind: string; re: RegExp; keep?: boolean }

// Values an assignment may hold without being a secret: placeholders and references to one kept elsewhere.
// A code expression (`config.apiKey`, `getToken()`, `process.env.DB_PASSWORD`, `os.environ["TOKEN"]`) names where a secret is read from, not the secret.
const PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]*\}\}|\*+|x+|\.\.\.|…|\[redacted:[a-z-]+\]|[A-Za-z_$][\w$]{0,60}(?:\.[A-Za-z_$][\w$]{0,60}|\[[^\]\n]{0,80}\]|\(\)){1,8})$/i;

// Every pattern is linear on the 128 KiB texts it sees: no nested or overlapping quantifiers, and the
// name before an assignment is bounded, so a hostile file can't make the scan backtrack for long.
const PATTERNS: readonly Pattern[] = [
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer-token', re: /(\b[Bb]earer[ \t]+)[A-Za-z0-9._~+/=-]{16,}/g, keep: true },
  { kind: 'basic-auth', re: /(\b[Bb]asic[ \t]+)[A-Za-z0-9+/=]{12,}/g, keep: true },
  // `scheme://user:password@host`: the scheme and user are kept, the password goes.
  { kind: 'url-credential', re: /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}:)([^\s@/]{3,200})(?=@)/gi, keep: true },
  // `password=...`, `API_KEY: "..."`, `token = '...'`: the name is kept, a value of 8 characters or more goes.
  { kind: 'credential-assignment', re: /(\b[A-Za-z0-9_.-]{0,40}?(?:password|passwd|pass|pwd|secret|token|api[_-]?key)["']?[ \t]*[:=][ \t]*)(?![A-Za-z_$][\w$]{0,60}(?:\.[A-Za-z_$][\w$]{0,60}|\[[^\]\n]{0,80}\]|\(\)){1,8}(?![^\s,;)]))("[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"',;]{8,})/gi, keep: true },
];
const KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY-----/g;
const KEY_END = /-----END (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY-----/g;

/**
 * PEM private key blocks, header to footer (RSA, EC, OPENSSH, ENCRYPTED, plain PRIVATE KEY), found by
 * walking headers and footers once rather than by a lazy regex that rescans the text from every header.
 * A header with no footer anywhere after it is a key cut short: it goes up to the next blank line (or
 * the end), so a rule that merely mentions the header doesn't take the rest of the text with it.
 */
function redactKeys(text: string, found: RedactionCounts): string {
  let out = '', at = 0, footerless = false;
  for (KEY_BEGIN.lastIndex = 0; ;) {
    const begin = KEY_BEGIN.exec(text);
    if (!begin) break;
    found['private-key'] = (found['private-key'] ?? 0) + 1;
    out += text.slice(at, begin.index) + '[redacted:private-key]';
    // Once no footer is left after a header, none is after any later one: the text is not searched again.
    KEY_END.lastIndex = begin.index + begin[0].length;
    const end = footerless ? null : KEY_END.exec(text);
    if (!end) footerless = true;
    const blank = end ? -1 : text.indexOf('\n\n', begin.index);
    at = end ? end.index + end[0].length : blank < 0 ? text.length : blank;
    KEY_BEGIN.lastIndex = at;
  }
  return out + text.slice(at);
}

/** Replaces every match of the patterns with `[redacted:<kind>]` and counts the kinds; the values are dropped, never returned. */
export function redactSecrets(text: string): { text: string; found: RedactionCounts } {
  const found: RedactionCounts = {};
  let out = redactKeys(text, found);
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
