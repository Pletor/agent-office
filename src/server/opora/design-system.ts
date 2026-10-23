// A project's design system: the DESIGN.md at the root of its repository (fonts, colours, brand,
// components), which a design card's worker follows exactly or, on an "explore" card, deliberately
// leaves aside. Opora may serve it (GET /api/oporahub/design-system, being built); until it does,
// the office reads the committed copy from the floor's own checkout.
import { execFileSync } from 'node:child_process';

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
}

/** A card's design mode: follow the brand (the default), or propose a new direction. */
export type DesignMode = 'brand' | 'explore';

export function designMode(value: unknown): DesignMode {
  return value === 'explore' ? 'explore' : 'brand';
}

function capped(text: string, source: DesignSystem['source']): DesignSystem | undefined {
  if (!text.trim()) return undefined;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= DESIGN_MD_CAP) return { text, source, truncated: false, bytes };
  return { text: Buffer.from(text, 'utf8').subarray(0, DESIGN_MD_CAP).toString('utf8').replace(/�+$/, ''), source, truncated: true, bytes };
}

/** The committed DESIGN.md at HEAD of the checkout in `dir` (not whatever is in the working tree), if there is one. */
export function readRepoDesignMd(dir: string): DesignSystem | undefined {
  try {
    const text = execFileSync('git', ['show', 'HEAD:DESIGN.md'], { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return capped(text, 'repo');
  } catch {
    return undefined;
  }
}

/** Opora's answer to GET /api/oporahub/design-system, if it has the endpoint and a text in it. */
export function fromOpora(body: unknown): DesignSystem | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const text = [b.markdown, b.text, b.content].find((x): x is string => typeof x === 'string');
  return text ? capped(text, 'opora') : undefined;
}
