// Reads a design card's preview from Opora for the process wall's card inspector (GET /api/opora-preview):
// `GET /api/oporahub/review-preview` (mode, DESIGN.md reference, sketch, screenshots per head),
// `GET /api/oporahub/design-system` (DESIGN.md, for its fonts and colours), and the card's drawing and
// storyboard (`/api/drawing`, `/api/storyboard`, only counted). Read-only GETs with the office's usual
// X-Opora-Actor, no lease token and never a write. JSON answers are kept 30 s; a 404 (an Opora without
// the endpoint), a timeout or a refusal is an answer too. The images (a sketch SVG, a screenshot PNG)
// are fetched for the office's own file route, capped, and only with the content type they must have.

import { previewOf, PREVIEW_FILE_ID, type OporaPreviewReply } from '../../shared/opora-preview.js';

const TTL_MS = 30_000;
const TIMEOUT_MS = 5000;
const MAX_JSON = 512 * 1024;
/** A drawing scene can carry pasted images; past this it only counts as "there is one". */
const MAX_DRAWING = 4 * 1024 * 1024;
const MAX_ENTRIES = 200;
export const MAX_PNG = 2 * 1024 * 1024 + 1024;
export const MAX_SVG = 1024 * 1024;

type Fetch = typeof fetch;
type Read = { status: number; data?: unknown; big?: boolean };
export type PreviewFile = { status: number; type?: 'image/png' | 'image/svg+xml'; body?: Buffer };

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the card is linked: Opora's address, the office's agent name, the project and workspace. */
export interface PreviewWhere { base: string; agent: string; project: string; workspace: string }

/** The counts the window needs from a drawing and a storyboard answer. */
export function sketchCounts(drawing: Read, storyboard: Read): Pick<OporaPreviewReply, 'drawing' | 'storyboard'> {
  const out: Pick<OporaPreviewReply, 'drawing' | 'storyboard'> = {};
  if (drawing.big) out.drawing = { elements: 1 };
  else {
    const els = obj(obj(drawing.data)?.scene)?.elements;
    const n = Array.isArray(els) ? els.filter((e) => obj(e) && obj(e)!.isDeleted !== true).length : 0;
    if (n) out.drawing = { elements: Math.min(n, 9999) };
  }
  const sb = obj(obj(storyboard.data)?.storyboard);
  if (sb) {
    const moments = Array.isArray(sb.moments) ? sb.moments : [];
    out.storyboard = { moments: Math.min(moments.length, 999), sketches: Math.min(moments.filter((m) => obj(m)?.sketch).length, 999) };
  }
  return out;
}

export class PreviewReader {
  private cache = new Map<string, { at: number; value: Promise<Read> }>();

  constructor(private fetcher: Fetch = fetch, private now: () => number = Date.now) {}

  /** The card's preview as the window shows it. */
  async card(w: PreviewWhere, nodeId: string): Promise<Omit<OporaPreviewReply, 'linked' | 'base' | 'nodeId'>> {
    const { project, workspace } = w;
    const [preview, drawing, storyboard] = await Promise.all([
      this.read(w, '/api/oporahub/review-preview', { project, workspace, nodeId }),
      this.read(w, '/api/drawing', { project, workspace, layer: nodeId }, MAX_DRAWING),
      this.read(w, '/api/storyboard', { project, workspace, nodeId }),
    ]);
    const counts = sketchCounts(drawing, storyboard);
    if (preview.status === 404) return { state: 'missing', mode: 'brand', sketch: !!counts.drawing, heads: [], ...counts };
    if (preview.status !== 200 || !obj(preview.data)) return { state: 'unavailable', mode: 'brand', sketch: !!counts.drawing, heads: [], ...counts };
    // DESIGN.md only for a brand card, or an explore card's "now" row: one more cached GET.
    const ds = await this.read(w, '/api/oporahub/design-system', { project });
    return { state: 'ok', ...previewOf(preview.data, ds.status === 200 ? ds.data : undefined), ...counts };
  }

  /**
   * A sketch (SVG) or one screenshot (PNG) of the card. A screenshot only when the card's own preview
   * lists its id, so the route can't be used to read any other image of the project.
   */
  async file(w: PreviewWhere, nodeId: string, kind: 'sketch' | 'shot', fileId?: string): Promise<PreviewFile> {
    const { project, workspace } = w;
    if (kind === 'shot') {
      if (!fileId || !PREVIEW_FILE_ID.test(fileId)) return { status: 400 };
      const p = await this.read(w, '/api/oporahub/review-preview', { project, workspace, nodeId });
      const listed = (Array.isArray(obj(p.data)?.heads) ? (obj(p.data)!.heads as unknown[]) : []).some((h) =>
        (Array.isArray(obj(h)?.screenshots) ? (obj(h)!.screenshots as unknown[]) : []).some((s) => obj(s)?.fileId === fileId));
      if (!listed) return { status: 404 };
      return this.bytes(w, '/api/oporahub/review-preview/file', { project, workspace, nodeId, fileId }, 'image/png', MAX_PNG);
    }
    return this.bytes(w, '/api/layout-preview', { project, workspace, layer: nodeId }, 'image/svg+xml', MAX_SVG);
  }

  private url(w: PreviewWhere, path: string, query: Record<string, string>): URL {
    const url = new URL(path, w.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private headers(w: PreviewWhere, accept: string) {
    return { Accept: accept, 'X-Opora-Actor': `agent; name=${w.agent}` };
  }

  private read(w: PreviewWhere, path: string, query: Record<string, string>, cap = MAX_JSON): Promise<Read> {
    const url = this.url(w, path, query);
    const key = `${w.agent} ${url.href}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    for (const [k, v] of this.cache) if (now - v.at >= TTL_MS) this.cache.delete(k);
    while (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    const value = this.getJson(url, w, cap);
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async getJson(url: URL, w: PreviewWhere, cap: number): Promise<Read> {
    try {
      const res = await this.fetcher(url, { method: 'GET', redirect: 'error', headers: this.headers(w, 'application/json'), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { void res.body?.cancel().catch(() => undefined); return { status: res.status }; }
      const body = await capped(res, cap);
      if (!body) return { status: 413, big: true };
      return { status: res.status, data: JSON.parse(body.toString('utf8')) };
    } catch {
      return { status: 0 };
    }
  }

  private async bytes(w: PreviewWhere, path: string, query: Record<string, string>, type: 'image/png' | 'image/svg+xml', cap: number): Promise<PreviewFile> {
    try {
      const res = await this.fetcher(this.url(w, path, query), { method: 'GET', redirect: 'error', headers: this.headers(w, type), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { void res.body?.cancel().catch(() => undefined); return { status: res.status === 404 ? 404 : 502 }; }
      const said = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (said !== type) { void res.body?.cancel().catch(() => undefined); return { status: 502 }; }
      const body = await capped(res, cap);
      if (!body) return { status: 413 };
      if (type === 'image/png' && !body.subarray(0, 8).equals(PNG)) return { status: 502 };
      if (type === 'image/svg+xml' && !/<svg[\s>]/i.test(body.subarray(0, 4096).toString('utf8'))) return { status: 502 };
      return { status: 200, type, body };
    } catch {
      return { status: 502 };
    }
  }
}

/** The body, or undefined once it's past `cap` bytes (stops reading there). */
async function capped(res: Response, cap: number): Promise<Buffer | undefined> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > cap) { void res.body?.cancel().catch(() => undefined); return undefined; }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { void reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const previewReader = new PreviewReader();
