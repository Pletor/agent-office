// A project's design system: the DESIGN.md at the root of its repository (fonts, colours, brand,
// components), which a design card's worker follows exactly or, on an "explore" card, deliberately
// leaves aside. Opora may serve it (GET /api/oporahub/design-system, being built); until it does,
// the office reads the committed copy from the floor's own checkout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** The most of a DESIGN.md the office reads; anything past it is cut and said to be. */
export const DESIGN_MD_CAP = 64 * 1024;

export interface DesignSystem {
  text: string;
  /** Where it came from: Opora's design-system endpoint, or the repository's committed DESIGN.md. */
  source: 'opora' | 'repo';
  /** It was longer than DESIGN_MD_CAP and was cut there. */
  truncated: boolean;
  /** Its full length in bytes, as found. */
  bytes: number;
  /** SHA-256 of the whole file (what a preview's `designMdSha256` carries), and the commit it was read at. */
  sha256?: string;
  revision?: string;
}

/** A card's design mode: follow the brand (the default), or propose a new direction. */
export type DesignMode = 'brand' | 'explore';

function capped(text: string, source: DesignSystem['source'], meta: Pick<DesignSystem, 'sha256' | 'revision'> & { bytes?: number } = {}): DesignSystem | undefined {
  if (!text.trim()) return undefined;
  const own = Buffer.byteLength(text, 'utf8');
  const bytes = meta.bytes ?? own;
  const ids = { ...(meta.sha256 ? { sha256: meta.sha256 } : {}), ...(meta.revision ? { revision: meta.revision } : {}) };
  if (own <= DESIGN_MD_CAP) return { text, source, truncated: bytes > own, bytes, ...ids };
  return { text: Buffer.from(text, 'utf8').subarray(0, DESIGN_MD_CAP).toString('utf8').replace(/\uFFFD+$/, ''), source, truncated: true, bytes, ...ids };
}

/** The committed DESIGN.md at HEAD of the checkout in `dir` (not whatever is in the working tree), if there is one. */
export function readRepoDesignMd(dir: string): DesignSystem | undefined {
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const raw = git(['show', 'HEAD:DESIGN.md']);
    const revision = git(['rev-parse', 'HEAD']).toString('utf8').trim();
    return capped(raw.toString('utf8'), 'repo', { sha256: createHash('sha256').update(raw).digest('hex'), revision, bytes: raw.length });
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * Opora's answer to GET /api/oporahub/design-system (docs/design-nahled.md §2 on Opora's side):
 * `{available, markdown, sha256, revision, bytes, truncated}`; `available: false` means it has none.
 */
export function fromOpora(body: unknown): DesignSystem | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (b.available === false) return undefined;
  const text = [b.markdown, b.text, b.content].find((x): x is string => typeof x === 'string');
  if (!text) return undefined;
  const found = capped(text, 'opora', { sha256: str(b.sha256), revision: str(b.revision), ...(typeof b.bytes === 'number' ? { bytes: b.bytes } : {}) });
  return found && b.truncated === true ? { ...found, truncated: true } : found;
}
