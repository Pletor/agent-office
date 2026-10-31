// 🗂️ Výstupy · Čistá linie's routes: the PRs merged into main over the last 7, 30 or 90 days and their
// outputs (docs/vystupy-board.md), for anyone signed in, and the project's change-diary artifact, which
// a signed-in browser on the office's own page may set or clear.
import { outputsBoard } from '../../cleanline/outputs.js';
import { OUTPUT_DAYS, OUTPUT_RANGES } from '../../../shared/outputs.js';
import type { Route } from '../router.js';
import { readBody, sameOrigin, send } from '../util.js';
import { live, targetOf } from './cleanline.js';

export const outputsRoutes = {
  read: {
    path: '/api/cleanline/outputs', auth: 'session',
    async handle(ctx, { req, res, url }) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Jen GET' }, { Allow: 'GET' });
      const raw = url.searchParams.get('days');
      const days = raw === null || raw === '' ? OUTPUT_DAYS : Number(raw);
      if (!OUTPUT_RANGES.includes(days)) return send(res, 400, { error: `days smí být ${OUTPUT_RANGES.join(', ')}` });
      const floorId = url.searchParams.get('floor');
      const target = targetOf(ctx, floorId, url.searchParams.get('repo'));
      if (!target) return send(res, 404, { error: 'Patro nebylo nalezeno' });
      const board = await outputsBoard(target.t, { live: live(ctx) }, url.searchParams.get('refresh') === '1', days);
      const diary = ctx.building.list().find((d) => d.id === floorId)?.diaryArtifact;
      return send(res, 200, diary ? { ...board, diaryArtifact: diary } : board);
    },
  },
  diary: {
    path: '/api/cleanline/outputs/diary', auth: 'session',
    async handle(ctx, { req, res, url }) {
      if (req.method !== 'PUT') return send(res, 405, { error: 'Jen PUT' }, { Allow: 'PUT' });
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Akce musí přijít ze stránky kanceláře' });
      const floorId = url.searchParams.get('floor') ?? '';
      if (!ctx.floors.get(floorId)) return send(res, 404, { error: 'Patro nebylo nalezeno' });
      let body: { url?: unknown };
      try {
        body = JSON.parse(await readBody(req, 4_000)) as { url?: unknown };
      } catch {
        return send(res, 400, { error: 'Neplatný požadavek' });
      }
      const why = ctx.building.setDiary(floorId, body?.url);
      if (why) return send(res, why === 'No such floor' ? 404 : 400, { error: why });
      return send(res, 200, { diaryArtifact: ctx.building.list().find((d) => d.id === floorId)?.diaryArtifact ?? '' });
    },
  },
} satisfies Record<string, Route>;
