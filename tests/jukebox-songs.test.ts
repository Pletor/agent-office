import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Jukebox } from '../src/server/jukebox.js';
import { deleteSong, keepSong, listSongs, songFile } from '../src/server/jukebox-songs.js';
import { STREAM, UPLOAD_PATH, checkJukeboxUrl, isAudioName, trackTitle, uploadName, uploadTitle, uploadedFile } from '../src/shared/jukebox.js';

const ID = '0123456789abcdef';

function dataDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-songs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an uploaded song is kept under a random id and a name that is safe in a URL', () => {
  assert.equal(uploadName('My Favourite Song (live).MP3', ID), `${ID}-My-Favourite-Song-live.mp3`);
  assert.equal(uploadName('Kolik času.flac', ID), `${ID}-Kolik-casu.flac`);
  assert.equal(uploadName('../../etc/passwd.wav', ID), `${ID}-passwd.wav`);
  assert.equal(uploadName('.mp3', ID), undefined);
  assert.equal(uploadName('(!!).mp3', ID), `${ID}-song.mp3`);
  assert.equal(uploadName('notes.txt', ID), undefined);
  assert.equal(uploadName('movie.mkv', ID), undefined);
  assert.equal(uploadName('constructor', ID), undefined);
  assert.equal(uploadName('weird.constructor', ID), undefined);
});

test('only audio files are taken', () => {
  assert.equal(isAudioName('track 01.opus'), true);
  assert.equal(isAudioName('clip.webm'), true);
  assert.equal(isAudioName('photo.jpg'), false);
  assert.equal(isAudioName(''), false);
});

test('an upload path is only what the office keeps, never another path', () => {
  const file = `${ID}-song.mp3`;
  assert.equal(uploadedFile(UPLOAD_PATH + file), file);
  assert.equal(uploadedFile(`${UPLOAD_PATH}${ID}-song.exe`), undefined);
  assert.equal(uploadedFile(`${UPLOAD_PATH}../accounts.json`), undefined);
  assert.equal(uploadedFile(`${UPLOAD_PATH}short-song.mp3`), undefined);
  assert.equal(uploadedFile('https://example.com/a.mp3'), undefined);
  assert.equal(uploadedFile(undefined), undefined);
});

test('the jukebox names an uploaded song by the name it had on the computer', () => {
  assert.equal(uploadTitle(`${ID}-My-Favourite-Song.mp3`), 'My Favourite Song');
  assert.equal(uploadTitle(`${ID}-rain_on_the_window-v2.ogg`), 'rain on the window v2');
  assert.equal(trackTitle({ track: STREAM, url: `${UPLOAD_PATH}${ID}-My-Favourite-Song.mp3` }), 'My Favourite Song');
  assert.equal(trackTitle({ track: STREAM, url: 'https://radio.example.com/live' }), 'radio.example.com · live');
});

test('a link to a song the office keeps is accepted next to a pasted link', () => {
  assert.deepEqual(checkJukeboxUrl(`${UPLOAD_PATH}${ID}-song.mp3`), { url: `${UPLOAD_PATH}${ID}-song.mp3` });
  assert.deepEqual(checkJukeboxUrl('https://radio.example.com/live'), { url: 'https://radio.example.com/live' });
  assert.ok('error' in checkJukeboxUrl('/etc/passwd'));
  assert.ok('error' in checkJukeboxUrl('javascript:alert(1)'));
});

test('a song is kept in the office and found again by its name', (t) => {
  const dir = dataDir(t);
  const file = keepSong(dir, 'Green Build.ogg', Buffer.from('ogg-bytes'));
  assert.ok(file);
  assert.equal(readFileSync(path.join(dir, 'jukebox', file), 'utf8'), 'ogg-bytes');
  assert.deepEqual(songFile(dir, file), { path: path.join(dir, 'jukebox', file), size: 9, type: 'audio/ogg' });
  assert.equal(songFile(dir, '../accounts.json'), undefined);
  assert.equal(songFile(dir, `${ID}-missing.mp3`), undefined);
  assert.equal(keepSong(dir, 'notes.txt', Buffer.from('x')), undefined);
});

test('a jukebox plays an uploaded song, and keeps it through a restart', (t) => {
  const dir = dataDir(t);
  const file = `${ID}-Green-Build.mp3`;
  const jb = new Jukebox(dir);
  assert.deepEqual(jb.play({ url: UPLOAD_PATH + file }, 'Ada'), { changed: true });
  const s = jb.state();
  assert.equal(s.on, true);
  assert.equal(s.track, STREAM);
  assert.equal(s.url, UPLOAD_PATH + file);
  assert.equal(s.by, 'Ada');
  assert.equal(jb.title(), 'Green Build');

  const back = new Jukebox(dir);
  assert.equal(back.state().on, true);
  assert.equal(back.state().url, UPLOAD_PATH + file);
  assert.equal(back.state().startedAt, s.startedAt);
});

test('a saved jukebox with a path that is not a song the office keeps is ignored', (t) => {
  const dir = dataDir(t);
  writeFileSync(path.join(dir, 'jukebox.json'), JSON.stringify({ on: true, track: STREAM, url: '/api/accounts.json', startedAt: 5 }));
  const jb = new Jukebox(dir);
  assert.equal(jb.state().on, false);
});

test('the kept songs are listed newest first, by name, and only the songs', (t) => {
  const dir = dataDir(t);
  assert.deepEqual(listSongs(dir), { songs: [], total: 0 });
  const older = keepSong(dir, 'Old Tune.mp3', Buffer.from('aaaa'))!;
  const newer = keepSong(dir, 'New Tune (remix).ogg', Buffer.from('bb'))!;
  utimesSync(path.join(dir, 'jukebox', older), new Date(1_000_000), new Date(1_000_000));
  utimesSync(path.join(dir, 'jukebox', newer), new Date(2_000_000), new Date(2_000_000));
  // Whatever else is in the folder isn't a song: not listed.
  writeFileSync(path.join(dir, 'jukebox', 'notes.txt'), 'x');
  writeFileSync(path.join(dir, 'jukebox', 'short-song.mp3'), 'x');
  mkdirSync(path.join(dir, 'jukebox', `${ID}-folder.mp3`));
  assert.deepEqual(listSongs(dir), {
    songs: [
      { file: newer, title: 'New Tune remix', size: 2, at: 2_000_000 },
      { file: older, title: 'Old Tune', size: 4, at: 1_000_000 },
    ],
    total: 2,
  });
  assert.equal(songFile(dir, `${ID}-folder.mp3`), undefined);
  // The list stops at its cap and says how many there are.
  assert.deepEqual(listSongs(dir, 1), { songs: [listSongs(dir).songs[0]], total: 2 });
});

test('a kept song can be deleted, and nothing outside the jukebox folder', (t) => {
  const dir = dataDir(t);
  const file = keepSong(dir, 'Bye.wav', Buffer.from('wav'))!;
  writeFileSync(path.join(dir, 'accounts.json'), '{}');
  writeFileSync(path.join(dir, 'jukebox', 'notes.txt'), 'x');
  for (const bad of ['../accounts.json', '..\accounts.json', `../jukebox/${file}`, `${file}/../../accounts.json`, '/etc/passwd', 'notes.txt', '', undefined, 42, `${ID}-missing.mp3`]) {
    assert.equal(deleteSong(dir, bad), false, String(bad));
  }
  assert.ok(existsSync(path.join(dir, 'accounts.json')));
  assert.ok(existsSync(path.join(dir, 'jukebox', 'notes.txt')));
  assert.equal(deleteSong(dir, file), true);
  assert.equal(songFile(dir, file), undefined);
  assert.equal(deleteSong(dir, file), false);
  assert.deepEqual(listSongs(dir), { songs: [], total: 0 });
});
