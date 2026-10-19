import type { BossAttention, BossAttentionItem } from '../../shared/boss-attention.js';
import type { OporaState } from '../../shared/protocol/opora.js';
import { ancestry, pipelineState, taskUrl, workRows } from './classify.js';
import { attentionSource, record, type AttentionSource } from './source.js';
import { beforeDeadline, DEADLINE_MESSAGE, READ_DEADLINE_MS } from './deadline.js';
import { completionBlockers } from './completion.js';
import { approvalGuidance, questionGuidance, systemGuidance } from './guidance.js';

export const BRIEF_CONCURRENCY = 4;
export const MAX_BRIEFS = 64;

function warning(id: string, reason: string, item?: Partial<BossAttentionItem>): BossAttentionItem {
  return { title: 'Údaje z Opory nejsou dostupné', path: [], reason, action: 'Zkontrolujte Oporu a obnovte přehled', ...item, id, kind: 'system' };
}

export function emptyAttention(state: OporaState): BossAttention {
  return {
    project: state.project ? { ...state.project } : null,
    workspace: state.workspace ? { id: state.workspace, label: state.workspaces.find((w) => w.id === state.workspace)?.label ?? state.workspace } : null,
    checkedAt: Date.now(), scope: 'linked-workspace', status: 'ready', items: [], system: [],
  };
}

/** Whole linked workspace: focus and office worker state deliberately do not participate. */
export async function readBossAttention(state: OporaState, source?: AttentionSource, signal = AbortSignal.timeout(READ_DEADLINE_MS)): Promise<BossAttention> {
  const board = emptyAttention(state);
  if (state.error) board.system.push(warning('bridge', state.error));
  for (const [index, run] of state.runs.entries()) {
    // Legacy runs without a workspace cannot safely be attributed to the current scope.
    if (!run.error || !state.project || !state.workspace || run.workspace !== state.workspace) continue;
    board.system.push(warning(`run:${run.cardId}:${run.startedAt}:${index}`, run.error, {
      nodeId: run.cardId, title: `Chyba běhu: ${run.cardName}`,
      path: [board.project!.name, board.workspace!.label], action: 'Zkontrolujte běh agenta v kanceláři',
    }));
  }
  if (!state.connected || !state.project || !state.workspace) {
    board.status = state.starting || !state.checkedAt ? 'loading' : !state.connected ? 'disconnected' : 'not-linked';
    board.error = state.error ?? (board.status === 'loading' ? 'Opora se ještě načítá' : board.status === 'disconnected' ? 'Opora není připojena' : 'Toto patro nemá propojený projekt a pracovní prostor');
    if (!board.system.length) board.system.push(warning(board.status, board.error));
    return board;
  }
  const project = board.project!;
  const workspace = board.workspace!;
  const api = source ?? attentionSource(state.url, project.id, workspace.id, signal);
  const [overview, canvas] = await Promise.allSettled([
    beforeDeadline(() => api.overview(), signal), beforeDeadline(() => api.nodes(), signal),
  ]);
  for (const [name, result] of [['overview', overview], ['canvas', canvas]] as const) {
    if (result.status === 'rejected') board.system.push(warning(name, result.reason instanceof Error ? result.reason.message : 'Načtení z Opory selhalo'));
  }
  if (overview.status === 'rejected') {
    board.status = 'error';
    board.error = 'Nepodařilo se načíst přehled propojeného pracovního prostoru';
    return board;
  }
  let rows;
  try { rows = workRows(overview.value); }
  catch (error) {
    board.status = 'error';
    board.error = (error as Error).message;
    board.system.push(warning('overview', board.error));
    return board;
  }
  if (canvas.status === 'rejected') board.status = 'partial';
  const nodes = new Map((canvas.status === 'fulfilled' ? canvas.value : []).map((n) => [n.id, n]));
  const proposed: { row: typeof rows[number]; item: Omit<BossAttentionItem, 'kind' | 'reason' | 'action'> }[] = [];
  for (const row of rows) {
    const invalid = !['waiting', 'claimed', 'waiting-human', 'proposed', 'done', 'blocked'].includes(row.status)
      ? 'Opora vrátila neznámý stav úkolu; potřebu zásahu nelze ověřit'
      : row.status === 'waiting-human' && !row.waitingOnHuman.length
        ? 'Úkol čeká na člověka, ale text požadavku se nepodařilo načíst' : undefined;
    if (!invalid && (row.status === 'done' || (!row.waitingOnHuman.length && row.status !== 'proposed'))) continue;
    const parents = ancestry(row.id, nodes);
    const item = {
      id: row.id, nodeId: row.id, title: nodes.get(row.id)?.name || row.name,
      path: [project.name, workspace.label, ...parents.path],
      ...(parents.error ? {} : { url: taskUrl(state.url, project.id, workspace.id, parents.parent, row.id) }),
    };
    if (invalid) {
      board.system.push(warning(`request:${row.id}`, invalid, item));
      board.status = 'partial';
      continue;
    }
    if (parents.error && canvas.status === 'fulfilled') {
      board.system.push(warning(`ancestry:${row.id}`, parents.error, item));
      board.status = 'partial';
    }
    for (const ask of row.waitingOnHuman) board.items.push({ ...item, id: `${row.id}:question:${ask.id}`, kind: 'question', reason: ask.ask, action: 'Postupuj podle kroků níže; odpověď se ukládá v Opoře.', guidance: questionGuidance(ask.id, ask.stage) });
    if (row.status === 'proposed' && !row.waitingOnHuman.length) proposed.push({ row, item });
  }
  if (proposed.length > MAX_BRIEFS) {
    board.status = 'partial';
    board.system.push(warning('brief-limit', `Bylo možné ověřit pouze ${MAX_BRIEFS} z ${proposed.length} návrhů dokončení`));
  }
  // Workers consume a shared index; every read has its own timeout and size limit.
  let next = 0;
  const results = new Map<number, { human?: BossAttentionItem[]; system?: BossAttentionItem; partial?: boolean }>();
  await Promise.all(Array.from({ length: Math.min(BRIEF_CONCURRENCY, proposed.length) }, async () => {
    for (;;) {
      if (signal.aborted) break;
      const index = next++;
      if (index >= Math.min(MAX_BRIEFS, proposed.length)) break;
      const { row, item } = proposed[index];
      try {
        const brief = await beforeDeadline(() => api.brief(row.id), signal);
        const loop = record(record(brief)?.loop);
        const done = record(loop?.done);
        if (done?.confirmed === true) continue;
        const asks = Array.isArray(loop?.waitingOnHuman) ? loop.waitingOnHuman.map(record).filter((ask) => typeof ask?.ask === 'string' && ask.ask.trim()) : [];
        if (asks.length) {
          results.set(index, { human: asks.map((ask, i) => ({ ...item, id: `${row.id}:question:${String(ask!.blockId ?? ask!.stageId ?? i)}`,
            kind: 'question', reason: (ask!.ask as string).trim(), action: 'Postupuj podle kroků níže; odpověď se ukládá v Opoře.', guidance: questionGuidance(String(ask!.blockId ?? ask!.stageId ?? i), typeof ask!.stageId === 'string') })) });
          continue;
        }
        const pipeline = pipelineState(brief);
        const blockers = completionBlockers(brief);
        if (pipeline === 'complete' && done?.by === 'agent' && done.confirmed === false &&
          loop?.openBlocks === 0 && Array.isArray(loop.waitingOnHuman) && loop.waitingOnHuman.length === 0 && !blockers.length && item.url) {
          results.set(index, { human: [{ ...item, kind: 'approval', reason: 'Agent navrhl dokončení; dostupné podklady splňují kontrolované podmínky převzetí.', action: 'Zkontroluj výsledek krok za krokem. Konečné potvrzení ukládá a znovu ověřuje Opora.', guidance: approvalGuidance() }] });
        } else {
          const incomplete = pipeline === 'incomplete';
          results.set(index, { partial: pipeline === 'unknown', system: warning(`proposal:${row.id}`,
            incomplete ? 'Dokončení bylo navrženo před koncem všech etap; zbývá práce agentů' : 'Podmínky převzetí nejsou kompletní; karta ještě není určena k tvému potvrzení.',
            { ...item, action: 'Není potřeba tvůj zásah. Tuto kartu nyní nepotvrzuj.', guidance: systemGuidance(state, row.id, blockers) }) });
        }
      } catch (error) {
        results.set(index, { partial: true, system: warning(`brief:${row.id}`, error instanceof Error ? error.message : 'Nepodařilo se načíst zadání úkolu', item) });
      }
    }
  }));
  for (const [, result] of [...results].sort(([a], [b]) => a - b)) {
    if (result.human) board.items.push(...result.human);
    if (result.system) board.system.push(result.system);
    if (result.partial) board.status = 'partial';
  }
  if (signal.aborted) {
    board.status = 'partial';
    board.system.push(warning('deadline', DEADLINE_MESSAGE));
  }
  if (state.error) board.status = 'partial';
  if (board.status === 'partial') board.error = 'Část údajů pracovního prostoru se nepodařilo ověřit; seznam může být neúplný';
  for (const item of board.system) item.guidance ??= systemGuidance(state, item.nodeId, [item.reason]);
  return board;
}

const scopeKey = (state: OporaState) => JSON.stringify([state.url, state.project?.id, state.workspace, state.connected]);

/** Re-read the accessor after I/O: an old workspace must never be returned for a changed floor. */
export async function currentBossAttention(read: () => OporaState, source?: AttentionSource,
  load: (state: OporaState) => Promise<BossAttention> = (state) => readBossAttention(state, source)): Promise<BossAttention> {
  const state = read();
  const key = scopeKey(state);
  const board = await load(state);
  const current = read();
  if (key === scopeKey(current)) return board;
  return { ...emptyAttention(current), status: 'loading', error: 'Propojený pracovní prostor se během načítání změnil; obnovte přehled',
    system: [warning('scope-changed', 'Propojený pracovní prostor se během načítání změnil; předchozí výsledky byly zahozeny')] };
}
