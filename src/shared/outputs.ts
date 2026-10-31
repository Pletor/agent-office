// 🗂️ Výstupy · Čistá linie: what each PR merged into main in the last days produced, read from the
// `## Výstup` section of its body (contract: docs/vystupy-board.md). Types the server and the page
// share, and the pure parser.

/** A picture or a page a PR points at. `image`: written as a picture and from a trusted host, so it may be an <img>. */
export interface OutputMedia {
  url: string;
  image: boolean;
}

/** What a PR's `## Výstup` section says. */
export interface PrOutputs {
  artifacts: string[];
  before?: OutputMedia;
  after?: OutputMedia;
  diagrams: OutputMedia[];
  /** `Vysvětlení:` lines, joined: plain text, never HTML (at most EXPLANATION_MAX characters). */
  explanation?: string;
}

export interface OutputCommit {
  sha: string;
  subject: string;
}

export interface MergedPr {
  number: number;
  title: string;
  url?: string;
  author: string;
  /** ISO time it was merged. */
  mergedAt: string;
  /** The PR's own commits. */
  commits: OutputCommit[];
  /** Its squash commit on main. */
  mainSha?: string;
  /** Undefined: "bez výstupu". */
  outputs?: PrOutputs;
  /** Why it has no outputs other than an empty body (its body couldn't be read). */
  note?: string;
}

export interface OutputsBoard {
  repo: { label: string; url?: string; main: string };
  checkedAt: number;
  days: number;
  /** Newest merged first. */
  prs: MergedPr[];
  counts: { merged: number; with: number; without: number };
  /** The project's own change-diary artifact (https://claude.ai/artifact/…), set per floor. */
  diaryArtifact?: string;
  /** Why the list may be incomplete (no gh, say). */
  note?: string;
  error?: string;
}

export const OUTPUT_DAYS = 7;
/** The ranges the board may be read over, in days. */
export const OUTPUT_RANGES: readonly number[] = [7, 30, 90];
export const EXPLANATION_MAX = 500;

/** `raw` as a diary artifact address: '' clears it, an https://claude.ai/artifact/… is kept, anything else is undefined. */
export function diaryUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text) return '';
  if (text.length > 500) return undefined;
  try {
    const u = new URL(text);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'claude.ai' && /^\/artifact\/[^/]+/.test(u.pathname) && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Hosts whose pictures may be shown as <img>: GitHub's and claude.ai. */
export const IMAGE_HOSTS: readonly string[] = ['github.com', 'user-images.githubusercontent.com', 'private-user-images.githubusercontent.com', 'raw.githubusercontent.com', 'claude.ai'];

/** Whether `url` is https on a host whose pictures may be shown. */
export function imageAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IMAGE_HOSTS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const httpUrl = (s: string | undefined) => {
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** The first URL in a line's value, and whether it was written as a picture. */
export function urlOf(value: string): { url: string; picture: boolean } | undefined {
  const tries: [RegExp, boolean][] = [
    [/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/, true],
    [/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i, true],
    [/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/, false],
    [/<(https?:\/\/[^>\s]+)>/i, false],
    [/(https?:\/\/[^\s)<>"']+)/i, false],
  ];
  for (const [re, picture] of tries) {
    const url = httpUrl(re.exec(value)?.[1]);
    if (url) return { url, picture };
  }
  return undefined;
}

const KEYS: Record<string, 'artifact' | 'before' | 'after' | 'diagram' | 'explain'> = {
  artefakt: 'artifact', 'před': 'before', pred: 'before', po: 'after', diagram: 'diagram', 'vysvětlení': 'explain', vysvetleni: 'explain',
};

/** The `## Výstup` section's lines, or undefined when the body has none. */
export function outputSection(body: string): string[] | undefined {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+výstup\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l.trim()));
  return end < 0 ? rest : rest.slice(0, end);
}

/** A PR body's outputs, or undefined ("bez výstupu") when it has no section or nothing valid in it. */
export function parseOutputs(body: string | undefined | null): PrOutputs | undefined {
  const section = outputSection(body ?? '');
  if (!section) return undefined;
  const out: PrOutputs = { artifacts: [], diagrams: [] };
  let any = false;
  const said: string[] = [];
  for (const raw of section) {
    const m = /^\s*(?:[-*]\s+)?([\p{L}\p{M}]+)\s*:\s*(.+)$/u.exec(raw);
    if (!m) continue;
    const key = KEYS[m[1].normalize('NFC').toLowerCase()];
    if (key === 'explain') {
      const text = m[2].trim();
      if (text) said.push(text);
      continue;
    }
    const found = key && urlOf(m[2]);
    if (!found) continue;
    any = true;
    const media: OutputMedia = { url: found.url, image: found.picture && imageAllowed(found.url) };
    if (key === 'artifact') out.artifacts.push(found.url);
    else if (key === 'diagram') out.diagrams.push(media);
    else if (key === 'before') out.before ??= media;
    else out.after ??= media;
  }
  const explanation = said.join(' ').slice(0, EXPLANATION_MAX).trim();
  if (explanation) out.explanation = explanation;
  return any || explanation ? out : undefined;
}

/** Counts for the board: merged, with outputs, without. */
export function countOutputs(prs: readonly MergedPr[]): OutputsBoard['counts'] {
  const withOut = prs.filter((p) => p.outputs).length;
  return { merged: prs.length, with: withOut, without: prs.length - withOut };
}

/** "12 PR · 9 s výstupem · 3 bez". */
export function countsLine(c: OutputsBoard['counts']): string {
  return `${c.merged} PR · ${c.with} s výstupem · ${c.without} bez`;
}
