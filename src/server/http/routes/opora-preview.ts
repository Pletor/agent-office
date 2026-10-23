// "Jak to bude vypadat" for a design card, for the process wall's card inspector:
// GET /api/opora-preview?floor=<id>&card=<nodeId> (JSON) and
// GET /api/opora-preview/file?floor=<id>&card=<nodeId>&kind=sketch|shot[&file=<id>] (the image bytes).
// The floor says which Opora project and workspace (its link), so the page never names a project it
// isn't on and never needs Opora's auth; the reads are opora/preview-reader.ts, GET only.
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';
import { previewReader } from '../../opora/preview-reader.js';
import { LENS_ID } from '../../../shared/opora-lens.js';
import type { OporaPreviewReply } from '../../../shared/opora-preview.js';

/** An image from Opora, served as an image only: no sniffing, no scripts even when opened on its own. */
const IMAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'cache-control': 'private, max-age=30',
};

export const oporaPreviewRoutes = {
  read: {
    method: 'GET',
    path: '/api/opora-preview',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const card = url.searchParams.get('card') ?? '';
      if (!LENS_ID.test(card)) return send(res, 400, { error: 'Bad card' });
      const o = floor.opora.view();
      if (!o.project || !o.workspace) {
        return send(res, 200, { linked: false, nodeId: card, state: 'unavailable', mode: 'brand', sketch: false, heads: [] } satisfies OporaPreviewReply);
      }
      const read = await previewReader.card({ base: o.url, agent: `office-${floor.id}`, project: o.project.id, workspace: o.workspace }, card);
      return send(res, 200, { linked: true, base: o.url, nodeId: card, ...read } satisfies OporaPreviewReply);
    },
  },
  file: {
    method: 'GET',
    path: '/api/opora-preview/file',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const card = url.searchParams.get('card') ?? '';
      const kind = url.searchParams.get('kind');
      if (!LENS_ID.test(card) || (kind !== 'sketch' && kind !== 'shot')) return send(res, 400, { error: 'Bad card or kind' });
      const o = floor.opora.view();
      if (!o.project || !o.workspace) return send(res, 404, { error: 'Floor not linked to Opora' });
      const f = await previewReader.file({ base: o.url, agent: `office-${floor.id}`, project: o.project.id, workspace: o.workspace }, card, kind, url.searchParams.get('file') ?? undefined);
      if (f.status !== 200 || !f.body || !f.type) return send(res, f.status, { error: 'No image' });
      res.writeHead(200, { 'content-type': f.type, 'content-length': String(f.body.length), ...IMAGE_HEADERS });
      res.end(f.body);
    },
  },
} satisfies Record<string, Route>;
