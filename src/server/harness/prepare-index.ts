// The preparation store read the way a take and a poll need it (prepare-store.ts holds the records and
// docs/harness.md "Preparation runner" the rules): the runs that aren't finished come from the index of
// active runs (`harness-prepared/active/`, one empty marker per run), always in full and never capped;
// a card's runs are the markers that start with its key. Final records (rolled back) have no marker:
// the sweep removes them by age and, past a count, the oldest first, and never touches a run that has a
// marker or isn't final. Everything here is asynchronous and the sweep stops at a time budget per call,
// so a large store never blocks the office's event loop. A store written before the index existed is
// indexed once, by reading every record, before anything is looked up in it.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activeDir, cardKey, deleteRecord, markerFile, parseRecord, preparedDir, recordFile, RUN_ID, type PreparedRecord } from './prepare-store.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

/** What the sweep keeps: final records younger than `finalMs`, and at most `keep` of them (the newest). */
export const FINAL_RETENTION = { finalMs: 7 * 24 * 60 * 60_000, keep: 200, budgetMs: 250 };
/** A marker whose record never came (a crash between the two) is removed once it is this old. */
const ORPHAN_MS = 60_000;
const MARKER = /^([0-9a-f]{32})\.([a-z0-9][a-z0-9-]{7,63})$/;
/** Written once every record of the store has its marker (or was found final). */
const indexedFlag = (dataDir: string) => path.join(activeDir(dataDir), '.indexed');

const indexing = new Map<string, Promise<void>>();
/** Indexes a store written before the index existed, once per data dir (a store that has the index, or no store yet, returns at once and writes nothing). */
export function ensureIndex(dataDir: string): Promise<void> {
  if (existsSync(indexedFlag(dataDir)) || !existsSync(preparedDir(dataDir))) return Promise.resolve();
  let running = indexing.get(dataDir);
  if (!running) {
    running = (async () => {
      await mkdir(activeDir(dataDir), { recursive: true });
      for (const name of await readdir(preparedDir(dataDir)).catch(() => [] as string[])) {
        const runId = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!RUN_ID.test(runId)) continue;
        const r = parseRecord(await readFile(recordFile(dataDir, runId), 'utf8').catch(() => ''), runId);
        if (r && r.state !== 'rolledBack') await writeFile(markerFile(dataDir, r), '', { mode: 0o600 });
      }
      await writeFile(indexedFlag(dataDir), new Date().toISOString(), { mode: 0o600 });
    })().finally(() => indexing.delete(dataDir));
    indexing.set(dataDir, running);
  }
  return running;
}

/**
 * The runs that aren't finished (every state but `rolledBack`, `seated` included), newest first, read
 * from the index; only the card's when `card` is given. A marker whose run was rolled back, or whose
 * record never came, is removed on the way.
 */
export async function activeRecords(dataDir: string, card?: { repo: string; card: OporaPlace & { nodeId: string } }): Promise<PreparedRecord[]> {
  await ensureIndex(dataDir);
  const only = card ? cardKey(card.repo, card.card) : undefined;
  const out: PreparedRecord[] = [];
  for (const name of await readdir(activeDir(dataDir)).catch(() => [] as string[])) {
    const m = MARKER.exec(name);
    if (!m || (only && m[1] !== only)) continue;
    const marker = path.join(activeDir(dataDir), name), runId = m[2];
    let raw: string;
    try { raw = await readFile(recordFile(dataDir, runId), 'utf8'); }
    catch {
      if (Date.now() - (await stat(marker).then((s) => s.mtimeMs, () => Date.now())) > ORPHAN_MS) await unlink(marker).catch(() => undefined);
      continue;
    }
    const r = parseRecord(raw, runId);
    // A damaged record is never acted on; its marker goes once the file is as old as a final record would be kept.
    if (!r) { if (Date.now() - (await stat(marker).then((s) => s.mtimeMs, () => Date.now())) > FINAL_RETENTION.finalMs) await unlink(marker).catch(() => undefined); continue; }
    if (r.state === 'rolledBack') { await unlink(marker).catch(() => undefined); continue; }
    if (cardKey(r.repo, r.card) !== m[1]) continue;
    out.push(r);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Removes final records: every one older than `finalMs`, then the oldest past `keep`. A record with a
 * marker is never a candidate, and each one is read before it goes: only a `rolledBack` record is
 * removed (a damaged file only by age). Stops when `budgetMs` is spent; the next poll goes on. Also
 * removes temporary files a crash left (after an hour). Returns the run ids removed.
 */
export async function sweepFinal(dataDir: string, now = Date.now(), retention: Partial<typeof FINAL_RETENTION> = {}): Promise<string[]> {
  const { finalMs, keep, budgetMs } = { ...FINAL_RETENTION, ...retention };
  await ensureIndex(dataDir);
  const started = Date.now(), spent = () => Date.now() - started > budgetMs;
  const dir = preparedDir(dataDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const active = new Set((await readdir(activeDir(dataDir)).catch(() => [] as string[])).map((n) => MARKER.exec(n)?.[2]).filter(Boolean));
  for (const name of names.filter((n) => n.endsWith('.tmp'))) {
    if (spent()) return [];
    if (now - (await stat(path.join(dir, name)).then((s) => s.mtimeMs, () => now)) > 60 * 60_000) await unlink(path.join(dir, name)).catch(() => undefined);
  }
  const finals: { runId: string; at: number }[] = [];
  for (const name of names) {
    const runId = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!RUN_ID.test(runId) || active.has(runId)) continue;
    const at = await stat(path.join(dir, name)).then((s) => s.mtimeMs, () => undefined);
    if (at !== undefined) finals.push({ runId, at });
    if (spent()) return [];
  }
  finals.sort((a, b) => b.at - a.at);
  const removed: string[] = [];
  for (const [i, { runId, at }] of finals.entries()) {
    const old = now - at > finalMs;
    if (!old && i < keep) continue;
    if (spent()) break;
    const r = parseRecord(await readFile(recordFile(dataDir, runId), 'utf8').catch(() => ''), runId);
    if (r ? r.state !== 'rolledBack' || existsSync(markerFile(dataDir, r)) : !old) continue;
    deleteRecord(dataDir, runId, r);
    removed.push(runId);
  }
  return removed;
}
