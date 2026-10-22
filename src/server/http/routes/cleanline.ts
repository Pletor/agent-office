// 🧹 Čistá linie's routes: the board's data (anyone signed in), and the two human-only actions,
// Sloučit and Uklidit (an admin or the shared password, same origin, written to the audit log).
import type http from 'node:http';
import path from 'node:path';
import type { Session } from '../../auth.js';
import { audit, cleanLine, cleanupFor, mergeHead, planFor, targets, type LineDeps, type Target } from '../../cleanline/index.js';
import type { Ctx } from '../../office/context.js';
import type { Route } from '../router.js';
import { readBody, sameOrigin, send } from '../util.js';
import { floorParam } from './files.js';

const mayAct = (s: Session) => !s.account || s.account.role === 'admin';
const who = (s: Session) => (s.account ? `${s.account.name} (${s.account.id})` : 'sdílené heslo');

/** Every seated worker in the building, with its worktree (as the status wall sees them). */
const live = (ctx: Ctx): LineDeps['live'] =>
  [...ctx.floors.values()].flatMap((f) => f.workers.list().map((w) => ({ name: w.name, ...(w.worktree ? { path: path.resolve(f.dir, w.worktree.path), branch: w.worktree.branch } : {}) })));

function targetOf(ctx: Ctx, floorId: string | null, repo: unknown): { list: Target[]; t: Target } | undefined {
  const floor = ctx.floors.get(floorId ?? '');
  if (!floor) return undefined;
  const list = targets(floor.dir, floor.project.name);
  const t = list.find((x) => x.id === repo) ?? list[0];
  return { list, t };
}

/** A POST action's body, after the checks every action makes. */
async function action(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, session: Session) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    send(res, 405, { error: 'Jen POST' });
    return undefined;
  }
  if (!sameOrigin(req, ctx.cfg)) {
    send(res, 403, { error: 'Akce musí přijít ze stránky kanceláře' });
    return undefined;
  }
  if (!mayAct(session)) {
    send(res, 403, { error: 'Slučovat a uklízet smí jen správce kanceláře' });
    return undefined;
  }
  try {
    const body = JSON.parse(await readBody(req, 64_000)) as Record<string, unknown>;
    const target = targetOf(ctx, typeof body.floor === 'string' ? body.floor : null, body.repo);
    if (!target) {
      send(res, 404, { error: 'Patro nebylo nalezeno' });
      return undefined;
    }
    return { body, t: target.t };
  } catch {
    send(res, 400, { error: 'Neplatný požadavek' });
    return undefined;
  }
}

export const cleanLineRoutes = [
  {
    path: '/api/cleanline', auth: 'session',
    async handle(ctx, { req, res, url, session }) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Jen GET' }, { Allow: 'GET' });
      const target = targetOf(ctx, url.searchParams.get('floor'), url.searchParams.get('repo'));
      if (!target) return send(res, 404, { error: 'Patro nebylo nalezeno' });
      const data = await cleanLine(target.t, { live: live(ctx) }, url.searchParams.get('refresh') === '1');
      return send(res, 200, { ...data, repos: target.list.map(({ id, label }) => ({ id, label })), canAct: mayAct(session) });
    },
  },
  {
    path: '/api/cleanline/cleanup-plan', auth: 'session', method: 'GET',
    async handle(ctx, { res, url, session }) {
      if (!mayAct(session)) return send(res, 403, { error: 'Uklízet smí jen správce kanceláře' });
      const target = targetOf(ctx, url.searchParams.get('floor'), url.searchParams.get('repo'));
      if (!target) return send(res, 404, { error: 'Patro nebylo nalezeno' });
      return send(res, 200, await planFor(target.t, { live: live(ctx) }));
    },
  },
  {
    path: '/api/cleanline/merge', auth: 'session',
    async handle(ctx, { req, res, session }) {
      const a = await action(ctx, req, res, session);
      if (!a) return;
      const n = Number(a.body.pr);
      const sha = typeof a.body.sha === 'string' ? a.body.sha : '';
      if (!Number.isInteger(n) || n <= 0 || !/^[0-9a-f]{40}$/.test(sha)) return send(res, 400, { error: 'Chybí číslo PR nebo commit jeho hlavy' });
      const r = await mergeHead(a.t, n, sha, { live: live(ctx) });
      audit(ctx.cfg.dataDir, who(session), 'sloučit', a.t, `PR #${n} @${sha.slice(0, 12)} squash: ${r.error ? `odmítnuto (${r.error})` : 'sloučeno'}`);
      return send(res, r.status, r.error ? { error: r.error } : { ok: true });
    },
  },
  {
    path: '/api/cleanline/cleanup', auth: 'session',
    async handle(ctx, { req, res, session }) {
      const a = await action(ctx, req, res, session);
      if (!a) return;
      const items = Array.isArray(a.body.items) ? a.body.items.filter((k): k is string => typeof k === 'string').slice(0, 500) : [];
      if (!items.length) return send(res, 400, { error: 'Prázdný seznam' });
      const r = await cleanupFor(a.t, items, { live: live(ctx) });
      audit(ctx.cfg.dataDir, who(session), 'uklidit', a.t, `smazáno: ${r.done.map((d) => d.name).join(', ') || 'nic'}; přeskočeno: ${r.skipped.length}; záloha: ${r.backup ?? '—'}`);
      return send(res, 200, r);
    },
  },
] satisfies Route[];
