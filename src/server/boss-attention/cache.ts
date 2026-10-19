import type { BossAttention } from '../../shared/boss-attention.js';
import type { OporaState } from '../../shared/protocol/opora.js';
import { currentBossAttention, readBossAttention } from './index.js';

export const CACHE_MS = 15_000;
interface Entry { key: string; until: number; pending: boolean; value: Promise<BossAttention> }
const cache = new WeakMap<object, Entry>();

/** One entry per floor: pending reads coalesce; a scope or bridge error change invalidates it. */
export function cachedBossAttention(floor: object, read: () => OporaState,
  load = readBossAttention, now = Date.now): Promise<BossAttention> {
  return currentBossAttention(read, undefined, (state) => {
    const key = JSON.stringify([state.url, state.project, state.workspace, state.workspaces,
      state.connected, state.starting, state.error,
      state.runs.filter((run) => run.workspace === state.workspace && run.error)]);
    const prior = cache.get(floor);
    if (prior?.key === key && (prior.pending || prior.until > now())) return prior.value;
    const entry: Entry = { key, until: 0, pending: true, value: Promise.resolve().then(() => load(state)) };
    cache.set(floor, entry);
    entry.value.then(() => { entry.pending = false; entry.until = now() + CACHE_MS; }, () => {
      if (cache.get(floor) === entry) cache.delete(floor);
    });
    return entry.value;
  });
}
