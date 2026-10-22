import type { Route } from '../router.js';
import { readBody, sameOrigin, send } from '../util.js';
import { memoryRecall, memoryStatus, oporaBase, readOpora, recallPayload } from '../../process-memory/client.js';

/** Opora memory is machine-wide, so only office admins/shared-password sessions can inspect it. */
export const processMemoryRoutes = [
  { method: 'GET', path: '/api/process-memory', auth: 'session', async handle(_ctx, { res, session }) {
    if (session.account && session.account.role !== 'admin') return send(res, 403, { error: 'Paměť Opory může číst správce kanceláře.' });
    const raw = process.env.OPORA_CONTROL_CENTER_URL;
    if (!raw) return send(res, 200, { status: 'not_configured', reason: 'Nastavte OPORA_CONTROL_CENTER_URL na serveru agent-office.', roles: [], missingRoles: [], checkedAt: Date.now() });
    try {
      const base = oporaBase(raw);
      const [status, roles] = await Promise.all([readOpora(base, '/api/memory/status'), readOpora(base, '/api/memory/roles')]);
      return send(res, 200, memoryStatus(status, roles));
    } catch { return send(res, 200, { status: 'unavailable', reason: 'Paměťové API Opory není dostupné nebo nevrátilo očekávaná data.', roles: [], missingRoles: [], checkedAt: Date.now() }); }
  } },
  { method: 'POST', path: '/api/process-memory/recall', auth: 'session', async handle(ctx, { req, res, session }) {
    if ((session.account && session.account.role !== 'admin') || !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Vyhledávání paměti vyžaduje správce a původ kanceláře.' });
    let payload;
    try { payload = recallPayload(JSON.parse(await readBody(req, 16000))); } catch { return send(res, 400, { error: 'Neplatná role, dotaz nebo ID projektu Opory.' }); }
    try {
      const base = oporaBase(process.env.OPORA_CONTROL_CENTER_URL || '');
      return send(res, 200, memoryRecall(await readOpora(base, '/api/memory/recall', payload), payload.role));
    } catch { return send(res, 503, { error: 'Vybavení paměti není dostupné. Zkontrolujte Oporu a OpenViking.' }); }
  } },
] satisfies Route[];
