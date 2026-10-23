// "Jak to bude vypadat" for a design card in the process wall's card inspector (GET /api/opora-preview):
// the card's design mode, the project's DESIGN.md (its fonts and colours, parsed from the markdown
// here), its sketch and storyboard, and the screenshots a design worker delivered per PR head, as
// Opora keeps them (`GET /api/oporahub/review-preview`, `GET /api/oporahub/design-system`). All of it
// is data agents or people wrote: only whitelisted fields, capped plain strings, never markup. Images
// come through the office's own proxy (GET /api/opora-preview/file), so the page needs no Opora auth.

import { str } from './opora-lens.js';

/** `brand` ("Podle brandu", the default) builds by the project's DESIGN.md; `explore` ("Nový směr") proposes a new one. */
export type DesignMode = 'brand' | 'explore';

/** A font and the colours a DESIGN.md names, as far as a small tolerant parser finds them. */
export interface DesignBrand {
  fonts: string[];
  colors: { hex: string; name?: string }[];
}

/** One screenshot of a head. `file` is Opora's content id, which the office's file route serves. */
export interface PreviewShot {
  label: string;
  width?: number;
  height?: number;
  stage?: string;
  file: string;
}

/** The screenshots for one head of the card's PR, newest head first. */
export interface PreviewHead {
  prNumber?: number;
  headSha?: string;
  prState?: string;
  current: boolean;
  mode: DesignMode;
  /** The DESIGN.md (sha256) the screenshots were built by; absent: none (explore, or no DESIGN.md). */
  designMdSha256?: string;
  /** The new DESIGN.md an explore card proposes, parsed for its fonts and colours (never the text itself). */
  proposed?: DesignBrand;
  confirmed?: { by: string; at?: string };
  shots: PreviewShot[];
}

export interface OporaPreviewReply {
  /** The floor is linked to an Opora project and workspace. */
  linked: boolean;
  base?: string;
  nodeId: string;
  /** ok: Opora answered; missing: an Opora without the endpoint (404); unavailable: no answer. */
  state: 'ok' | 'missing' | 'unavailable';
  mode: DesignMode;
  designSystem?: { available: boolean; revision?: string; sha256?: string; truncated?: boolean; brand?: DesignBrand };
  /** Opora has a sketch of the card (its `sketchUrl`); the image is the file route's `kind=sketch`. */
  sketch: boolean;
  drawing?: { elements: number };
  storyboard?: { moments: number; sketches: number };
  heads: PreviewHead[];
}

/** Caps on what the window shows. */
export const PREVIEW_MAX = { heads: 4, shots: 8, fonts: 3, colors: 8, markdown: 64 * 1024 } as const;
/** Opora's screenshot ids (`preview_<sha256>`), and any other plain id it might use. */
export const PREVIEW_FILE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** A font family name as CSS may get it: letters, digits, spaces and dashes, no quotes or semicolons. */
const FONT = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u;

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined);
const sha = (v: unknown) => (typeof v === 'string' && SHA.test(v) ? v.toLowerCase() : undefined);

export const designMode = (v: unknown): DesignMode => (v === 'explore' ? 'explore' : 'brand');

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'emoji', 'math']);

/** The first font family of a CSS-like list (`'Nunito', system-ui`), or a name in backticks. */
function fontName(raw: string): string | undefined {
  for (const part of raw.split(/[,/|]/)) {
    const name = part.replace(/[`'"*_]/g, '').replace(/\(.*$/, '').trim();
    if (!name || GENERIC.has(name.toLowerCase()) || name.startsWith('-') || name.startsWith('#')) continue;
    if (FONT.test(name)) return name;
  }
  return undefined;
}

/**
 * The fonts and colours a DESIGN.md names, read leniently from its markdown: lines about a font
 * (`font`, `typeface`, `písmo`, `font-family`) give a family name, and every hex colour gives a
 * swatch, named by what's before it on the line. Never more than a few of each, and never markup:
 * the page shows these as text and as a validated CSS colour or family name.
 */
export function parseDesignMd(markdown: unknown): DesignBrand {
  const fonts: string[] = [];
  const colors: DesignBrand['colors'] = [];
  if (typeof markdown !== 'string') return { fonts, colors };
  for (const line of markdown.slice(0, PREVIEW_MAX.markdown).split('\n').slice(0, 2000)) {
    const font = /(?:font[- ]?family|typeface|font|p[ií]smo|typografie)[^:=|]*[:=|]\s*(.+)$/i.exec(line);
    if (font && fonts.length < PREVIEW_MAX.fonts) {
      const name = fontName(font[1].replace(/^\s*\|?\s*/, ''));
      if (name && !fonts.includes(name)) fonts.push(name);
    }
    for (const m of line.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      if (colors.length >= PREVIEW_MAX.colors) break;
      const hex = m[0].toLowerCase();
      if (!HEX.test(hex) || colors.some((c) => c.hex === hex)) continue;
      const before = line.slice(0, m.index).replace(/[`*_|:=>-]+/g, ' ').replace(/\s+/g, ' ').trim();
      const name = str(before.split(' ').slice(-2).join(' '), 24);
      colors.push(name && /\p{L}/u.test(name) ? { hex, name } : { hex });
    }
  }
  return { fonts, colors };
}

function shot(raw: unknown): PreviewShot | undefined {
  const s = obj(raw), vp = obj(s?.viewport);
  const label = str(s?.label, 60), file = typeof s?.fileId === 'string' && PREVIEW_FILE_ID.test(s.fileId) ? s.fileId : undefined;
  if (!label || !file) return undefined;
  const stage = str(s?.stage, 60);
  const width = int(vp?.width, 120, 8000), height = int(vp?.height, 120, 20000);
  return { label, file, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(stage ? { stage } : {}) };
}

function head(raw: unknown): PreviewHead | undefined {
  const d = obj(raw);
  if (!d) return undefined;
  const shots = (Array.isArray(d.screenshots) ? d.screenshots : []).slice(0, PREVIEW_MAX.shots).map(shot).filter((s): s is PreviewShot => !!s);
  const c = obj(d.confirmed);
  const by = c ? str(c.by, 40) : undefined;
  const out: PreviewHead = { current: d.current === true, mode: designMode(d.mode), shots };
  const prNumber = int(d.prNumber, 1, 1e9), headSha = sha(d.headSha), prState = str(d.prState, 20), md = sha(d.designMdSha256);
  if (prNumber) out.prNumber = prNumber;
  if (headSha) out.headSha = headSha;
  if (prState) out.prState = prState;
  if (md) out.designMdSha256 = md;
  if (typeof d.proposedDesignMd === 'string' && d.proposedDesignMd.trim()) out.proposed = parseDesignMd(d.proposedDesignMd);
  if (c && by) out.confirmed = { by, ...(str(c.at, 40) ? { at: str(c.at, 40) } : {}) };
  return out;
}

/** Opora's `review-preview` answer (and the `design-system` one, when read) as the window shows it. */
export function previewOf(data: unknown, designSystem?: unknown): Omit<OporaPreviewReply, 'linked' | 'base' | 'nodeId' | 'state' | 'drawing' | 'storyboard'> {
  const d = obj(data) ?? {};
  const ds = obj(d.designSystem), full = obj(designSystem);
  const heads = (Array.isArray(d.heads) ? d.heads : []).slice(0, PREVIEW_MAX.heads).map(head).filter((x): x is PreviewHead => !!x);
  const out: ReturnType<typeof previewOf> = { mode: designMode(obj(d.design)?.mode), sketch: typeof d.sketchUrl === 'string' && d.sketchUrl.length > 0, heads };
  if (ds || full) {
    const src = ds ?? full!;
    const available = src.available === true;
    const revision = typeof src.revision === 'string' && SHA.test(src.revision) ? src.revision.toLowerCase() : undefined;
    out.designSystem = { available, ...(revision ? { revision } : {}), ...(sha(src.sha256) ? { sha256: sha(src.sha256) } : {}), ...(src.truncated === true ? { truncated: true } : {}) };
    if (available && full && typeof full.markdown === 'string') out.designSystem.brand = parseDesignMd(full.markdown);
  }
  return out;
}

/** The office's proxy address of a card's sketch (SVG) or one of its screenshots (PNG), for an `<img>`. */
export function previewFileUrl(floor: string, card: string, kind: 'sketch' | 'shot', file?: string): string {
  const q = new URLSearchParams({ floor, card, kind, ...(file ? { file } : {}) });
  return `/api/opora-preview/file?${q}`;
}
