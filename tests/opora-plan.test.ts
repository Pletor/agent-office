import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLane, groupCards, UNASSIGNED } from '../src/client/features/opora-plan/cards.ts';
import { oporaPlanRoutes } from '../src/server/http/routes/opora-plan.ts';
import type { OporaCard } from '../src/shared/protocol.ts';
import type { Lane } from '../src/client/features/process-wall/lanes.ts';

const card = (id: string, name: string, sectorName?: string, status: OporaCard['status'] = 'frontier'): OporaCard => ({ id, name, sectorName, status, group: 'dev' });
const cards = [card('c3', 'Živý proces', 'Kancelář'), card('c1', 'Lens plánu', 'Kancelář', 'claimed'), card('c2', 'Bez místa'), card('c4', 'Brána', 'Auth')];

test('groupCards groups by area, Nezařazeno last, each by name', () => {
  const g = groupCards(cards);
  assert.deepEqual(g.map((x) => [x.area, x.cards.map((c) => c.id)]), [['Auth', ['c4']], ['Kancelář', ['c1', 'c3']], [UNASSIGNED, ['c2']]]);
});

test('groupCards searches name, id and area, without diacritics, every word', () => {
  assert.deepEqual(groupCards(cards, 'planu').flatMap((g) => g.cards.map((c) => c.id)), ['c1']);
  assert.deepEqual(groupCards(cards, 'kancelar zivy').flatMap((g) => g.cards.map((c) => c.id)), ['c3']);
  assert.deepEqual(groupCards(cards, 'nezarazeno').flatMap((g) => g.cards.map((c) => c.id)), ['c2']);
  assert.deepEqual(groupCards(cards, 'nic takoveho'), []);
});

test('cardLane uses the wall lane when there is one, else a quiet lane with the card id', () => {
  const own = { key: 'card:c1', cardId: 'c1', name: 'x' } as Lane;
  assert.deepEqual(cardLane(cards[1], [own]), { lane: own, onWall: true });
  const { lane, onWall } = cardLane(cards[0], [own]);
  assert.equal(onWall, false);
  assert.equal(lane.cardId, 'c3');
  assert.equal(lane.marker, 'none');
  assert.equal(lane.events.length, 0);
  assert.equal(lane.trail.length, 7);
  assert.equal(lane.working, false);
});

test('GET /api/opora-plan-lens says when the floor is not linked, and 404s an unknown floor', async () => {
  const sent: { status: number; body: unknown }[] = [];
  const res = { writeHead(status: number) { sent.push({ status, body: undefined }); return this; }, setHeader() {}, end(b?: string) { if (sent.length) sent[sent.length - 1].body = b ? JSON.parse(b) : undefined; } };
  const floor = { id: 'f', opora: { view: () => ({ url: 'http://127.0.0.1:8740', project: null, workspace: null }) } };
  const ctx = { floors: new Map([['f', floor]]) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (q: string) => oporaPlanRoutes.read.handle(ctx as any, { res, url: new URL(`http://x/api/opora-plan-lens?${q}`) } as any);
  await call('floor=f');
  assert.deepEqual(sent.at(-1), { status: 200, body: { linked: false, plan: { state: 'none' } } });
  await call('floor=nope');
  assert.equal(sent.at(-1)!.status, 404);
});
