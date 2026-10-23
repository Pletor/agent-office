// Committing a JSON store file one revision at a time so that two writers can never both commit on top
// of the same revision, whatever happened to the lock (lock.ts is best effort). This is what prevents
// lost updates; the lock only keeps honest writers from colliding.
//
// - A revision is published by an exclusive create: the new text goes to a temp file, which is then
//   hard-linked to `<file>.rev.<N>.<digest of the text it was built on>`. `link` fails with EEXIST when
//   that name is taken, that is when another writer already published a successor of the very same
//   text: the loser gets a `RevisionConflict` (the store answers 409) and its publish is not kept.
//   A stale lock holder, or a writer whose lock was displaced, fails here instead of overwriting. A
//   published file that exists but can't be read as that revision (a file damaged by a power loss) is
//   a `DamagedRevision`: the store says which file to remove instead of refusing every save forever.
// - Then a copy of the text atomically replaces the main file (rename), which is all an older office reads:
//   the main file's format is unchanged, so a rollback reads it as before.
// - Reading follows the published revisions from the main file: the successor of a text is the file named
//   by its revision + 1 and its digest. So a crash between the publish and the rename (the main file
//   behind), a main file that can't be replaced (read-only), or a slow writer that renamed its older text
//   over a newer one, is read correctly, and the next save that can replace the main file puts the
//   latest text there. A main file edited by hand, or written by an older office, has a text no revision
//   was published on, so nothing is followed from it; a restored copy of one of the kept revisions is
//   that very text, and the walk leads from it to the latest revision again (remove the `.rev.*` files
//   when restoring).
// - Published files are pruned to the latest `KEEP_REVISIONS`, never above the main file's revision, so
//   the walk from the main file always finds its successors. Temp files a crashed writer left are removed
//   after an hour.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** How many published revisions stay next to the main file. */
export const KEEP_REVISIONS = 10;

/** Another writer published this revision first: reload and save again. */
export class RevisionConflict extends Error {
  constructor() { super('Another writer committed this revision first.'); }
}
/** The file this revision would be published as exists and can't be read as it: someone has to remove it. */
export class DamagedRevision extends Error {
  constructor(readonly file: string) { super(`The published revision ${file} is damaged: remove that file, then save again.`); }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The name revision `revision` is published under when it was built on `base` ('' when there was no file). */
export function revisionFile(file: string, revision: number, base: string): string {
  return `${file}.rev.${revision}.${digest(base)}`;
}

/** Reads a file, waiting out Windows' brief refusal while another process replaces it; undefined when it isn't there. */
export function readStoreText(file: string): string | undefined {
  // Synchronous, so a short spin (tens of attempts, no sleep): it covers the rename itself, not a slow writer.
  for (let attempt = 0; ; attempt++) {
    try { return readFileSync(file, 'utf8'); }
    catch (err) {
      if (code(err) === 'ENOENT') return undefined;
      if ((code(err) === 'EPERM' || code(err) === 'EBUSY') && attempt < 50) continue;
      throw err;
    }
  }
}

/**
 * The store as committed: the main file, advanced along the revisions published after it. `parse` turns
 * a text into the store (it throws for an invalid one: for the main file that error is the caller's, a
 * published file that doesn't parse, or doesn't carry the next revision, ends the walk). `text` is what a
 * save builds on and passes to `publishRevision` as its base; '' and `value` undefined when there is nothing yet.
 */
export function readCommitted<T extends { revision: number }>(file: string, parse: (text: string) => T): { text: string; value: T | undefined } {
  const main = readStoreText(file);
  let text = main ?? '';
  let value = main === undefined ? undefined : parse(main);
  for (let step = 0; step < 1000; step++) {
    const revision = (value?.revision ?? 0) + 1;
    try {
      const raw = readStoreText(revisionFile(file, revision, text));
      if (raw === undefined) break;
      const next = parse(raw);
      if (next.revision !== revision) break;
      text = raw;
      value = next;
    } catch { break; }
  }
  return { text, value };
}

/** Writes a new file and flushes it to disk, so a published revision survives a power loss whole. */
function writeDurable(file: string, text: string) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Commits `text` as `revision`, built on `base` (the `text` readCommitted returned). `fence` runs right
 * before the publish (the lock's `verify()`). A `RevisionConflict` means another writer published a
 * successor of `base` first, and this publish was not kept. Once published the save is committed:
 * replacing the main file after it is retried, and if it still fails the next save completes it.
 * `revisionOf` reads a text's revision (undefined when it isn't valid). A main file already at `revision`
 * or later, of another text, means `base` was not the latest (an older office wrote the main file, or a
 * pause outlasted the pruning), so the publish is withdrawn as a conflict too, unless a successor was
 * already published on top of it (then it is part of the history and stays committed).
 */
export async function publishRevision(file: string, revision: number, base: string, text: string, options: { fence?: () => void; revisionOf?: (text: string) => number | undefined } = {}): Promise<void> {
  const temp = file + '.' + randomUUID() + '.tmp';
  const published = revisionFile(file, revision, base);
  writeDurable(temp, text);
  try {
    options.fence?.();
    try { linkSync(temp, published); }
    catch (err) {
      if (code(err) !== 'EEXIST') throw err;
      let there: number | undefined = revision;
      try { const raw = readStoreText(published); if (raw !== undefined && options.revisionOf) there = options.revisionOf(raw); } catch { /* not readable now: a conflict */ }
      if (there !== revision) throw new DamagedRevision(published);
      throw new RevisionConflict();
    }
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
  const successor = revisionFile(file, revision + 1, text);
  let main: string | undefined;
  try { main = readStoreText(file); } catch { /* not readable now: the walk from it decides later */ }
  const ahead = main !== undefined && main !== base && main !== text ? options.revisionOf?.(main) : undefined;
  if (ahead !== undefined && ahead >= revision && !existsSync(successor)) {
    // Nobody reaches this file: a walk gets to it only from `base`, the main file is another text, and nothing was built on it.
    try { unlinkSync(published); } catch { /* already gone */ }
    throw new RevisionConflict();
  }
  // The main file gets a copy of its own, so writing it in place (by hand, or an older office) never changes a published revision.
  // A successor already published means a later writer has put, or will put, a newer text there.
  if (!existsSync(successor)) {
    const copy = file + '.' + randomUUID() + '.tmp';
    try { writeDurable(copy, text); await replaceMain(copy, file); }
    catch { /* committed anyway: readers follow the published revision, and the next save completes the main file */ }
    finally { try { unlinkSync(copy); } catch { /* renamed into place */ } }
  }
  // Never prune above the main file's revision: the walk from it needs every successor up to the latest.
  let floor = 0;
  try { const now = readStoreText(file); floor = Math.min(revision, now === undefined ? 0 : options.revisionOf?.(now) ?? 0); } catch { /* keep everything */ }
  prune(file, floor);
}

/** Renames the temp file over the main file; Windows refuses that for a moment while another process reads it. */
async function replaceMain(temp: string, file: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { renameSync(temp, file); return; }
    catch (err) {
      if (code(err) !== 'EPERM' && code(err) !== 'EBUSY') return; // committed anyway: readers follow the published revision
      await sleep(5 + Math.random() * 20);
    }
  }
}

/** Removes published revisions more than `KEEP_REVISIONS` below `revision` (the main file's, at most the new one), and old temp files. */
function prune(file: string, revision: number) {
  const dir = path.dirname(file), prefix = path.basename(file) + '.rev.';
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const temps = path.basename(file) + '.';
  for (const name of names) {
    if (name.startsWith(temps) && name.endsWith('.tmp')) {
      try { if (Date.now() - statSync(path.join(dir, name)).mtimeMs > 3_600_000) unlinkSync(path.join(dir, name)); } catch { /* in use, or gone */ }
      continue;
    }
    if (!name.startsWith(prefix)) continue;
    const n = Number(name.slice(prefix.length).split('.')[0]);
    if (Number.isSafeInteger(n) && n <= revision - KEEP_REVISIONS) { try { unlinkSync(path.join(dir, name)); } catch { /* removed by another writer */ } }
  }
}
