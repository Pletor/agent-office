import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateError, TicketGate, ticketBrief, validTicket } from '../src/server/opora/ticket-gate.js';

const scope = { project: 'p1', workspace: 'draft' };

/** A gate that forgets every token once (401), as after OPORA's restart, and answers each request. */
function fakeGate() {
  const calls: { path: string; token?: string; body: Record<string, unknown> }[] = [];
  let issued = 0, forgotten = false;
  const transport = (async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const token = (init.headers as Record<string, string>)['X-Opora-Gate-Token'];
    calls.push({ path: url.pathname, token, body });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/gate/sessions') return reply(201, { sessionId: `gs${++issued}`, token: `token-${issued}`, expiresAt: '2030-01-01T00:00:00Z' });
    if (token === 'token-1' && !forgotten) { forgotten = true; return reply(401, { code: 'gate_token_invalid', error: 'unknown' }); }
    if (body.kind === 'ticket.deliver') return reply(409, { code: 'ticket_state', error: 'open question' });
    return reply(201, { ticketId: 'gt_1', status: 'answered', answer: { ticket: null, held: false } });
  }) as typeof fetch;
  return { calls, gate: new TicketGate('http://127.0.0.1:1', { name: 'office-x', floor: 'x' }, transport) };
}

test('the gate opens a worker session, and a fresh one when OPORA forgot the token', async () => {
  const { calls, gate } = fakeGate();
  assert.deepEqual(await gate.request(scope), { ticket: null, held: false });
  assert.deepEqual(calls.map((c) => [c.path, c.token]), [['/api/gate/sessions', undefined], ['/api/gate/requests', 'token-1'], ['/api/gate/sessions', undefined], ['/api/gate/requests', 'token-2']]);
  assert.deepEqual(calls[0].body, { ...scope, worker: { name: 'office-x', floor: 'x' } });
  // A ticket's own session is apart from the lobby's.
  await gate.request(scope, 'tk_1');
  assert.equal(calls.filter((c) => c.path === '/api/gate/sessions').length, 3);
});

test('a gate refusal carries its code, never the token', async () => {
  const { gate } = fakeGate();
  const error = await gate.deliver(scope, 'tk_1', 'done', 'abc1234').catch((e: unknown) => e);
  assert.ok(error instanceof GateError);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'ticket_state');
  assert.doesNotMatch(error.message, /token-/);
});

test('a ticket is read only in its documented shape, and its body becomes a brief without ids', () => {
  assert.equal(validTicket(null), null);
  assert.equal(validTicket({ ticketId: 'tk 1', status: 'issued', machine: { cardId: 'c1' } }), null);
  assert.equal(validTicket({ ticketId: 'tk_1', status: 'issued', machine: {} }), null);
  const ticket = validTicket({ ticketId: 'tk_1', status: 'issued', machine: { cardId: 'c1' }, body: { essence: 'Why', skills: ['/ponytail@5.3.3', 7] } })!;
  assert.deepEqual(ticket.body.skills, ['/ponytail@5.3.3']);
  // The heart's department and profile are slugs, or null.
  assert.deepEqual([ticket.machine.department, ticket.machine.profile], [null, null]);
  const routed = validTicket({ ticketId: 'tk_2', status: 'issued', machine: { cardId: 'c1', department: 'frontend', profile: 'design' } })!;
  assert.deepEqual([routed.machine.department, routed.machine.profile], ['frontend', 'design']);
  const odd = validTicket({ ticketId: 'tk_3', status: 'issued', machine: { cardId: 'c1', department: '../x', profile: 7 } })!;
  assert.deepEqual([odd.machine.department, odd.machine.profile], [null, null]);
  const brief = ticketBrief(ticket.body);
  assert.match(brief, /Essence[\s\S]*Why[\s\S]*Skills to use \(pinned\):\n- \/ponytail@5\.3\.3/);
  assert.doesNotMatch(brief, /tk_1|c1/);
  assert.equal(ticketBrief({}), '');
});
