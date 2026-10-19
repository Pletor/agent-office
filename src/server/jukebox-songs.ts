import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AUDIO_TYPES, JUKEBOX_LIST_MAX, UPLOAD_PATH, uploadName, uploadTitle, uploadedFile, type JukeboxSong } from '../shared/jukebox.js';

// Songs someone uploaded to the jukebox from their own computer, kept on the office's machine in
// .agent-office/jukebox/ so they play after a restart. Anyone signed in can play one; only an admin can
// delete one (see http/routes/jukebox.ts). A name is only ever one that uploadedFile accepts (a random
// hex id, then letters, digits, dots and dashes), so nothing outside that folder can be read or deleted.

const folder = (dataDir: string) => path.join(dataDir, 'jukebox');

/** The kept name `file` stands for, or undefined when it isn't one keepSong could have made. */
const keptName = (file: unknown) => uploadedFile(typeof file === 'string' ? UPLOAD_PATH + file : undefined);

/** Keeps an uploaded song; the name it's kept under, or undefined if it isn't an audio file or can't be kept. */
export function keepSong(dataDir: string, name: string, body: Buffer): string | undefined {
  const file = uploadName(name, randomBytes(8).toString('hex'));
  if (!file) return undefined;
  try {
    mkdirSync(folder(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(folder(dataDir), file), body, { mode: 0o600, flag: 'wx' });
    return file;
  } catch {
    return undefined;
  }
}

/** A kept song, where it is and how big, or undefined when there's no such song (`file` is what keepSong returned). */
export function songFile(dataDir: string, file: unknown): { path: string; size: number; type: string } | undefined {
  const name = keptName(file);
  if (!name) return undefined;
  const p = path.join(folder(dataDir), name);
  try {
    const st = statSync(p);
    return st.isFile() ? { path: p, size: st.size, type: AUDIO_TYPES[name.slice(name.lastIndexOf('.') + 1)] } : undefined;
  } catch {
    return undefined;
  }
}

/** The songs the office keeps, newest first, `max` at most, and how many there are in all. */
export function listSongs(dataDir: string, max = JUKEBOX_LIST_MAX): { songs: JukeboxSong[]; total: number } {
  let names: string[];
  try {
    names = readdirSync(folder(dataDir));
  } catch {
    return { songs: [], total: 0 };
  }
  const songs: JukeboxSong[] = [];
  for (const name of names) {
    if (keptName(name) !== name) continue;
    try {
      const st = statSync(path.join(folder(dataDir), name));
      if (st.isFile()) songs.push({ file: name, title: uploadTitle(name), size: st.size, at: Math.round(st.mtimeMs) });
    } catch {
      // Gone between the listing and the look: it isn't kept any more.
    }
  }
  songs.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title));
  return { songs: songs.slice(0, Math.max(0, max)), total: songs.length };
}

/** Deletes a kept song; whether there was one to delete. */
export function deleteSong(dataDir: string, file: unknown): boolean {
  const song = songFile(dataDir, file);
  if (!song || path.dirname(song.path) !== folder(dataDir)) return false;
  try {
    unlinkSync(song.path);
    return true;
  } catch {
    return false;
  }
}
