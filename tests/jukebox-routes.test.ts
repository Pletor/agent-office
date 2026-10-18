// Boots the real office (as server-dispatch.test.ts does) and uses the jukebox's song routes as a browser
// would: uploading, listing, playing one back, deleting one as an admin, and being turned away otherwise.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { UPLOAD_PATH, type JukeboxSong } from '../src/shared/jukebox.js';

type Office = Awaited<ReturnType<typeof startServer>>;

let tmp = '';
let office: Office;
let base = '';
let dataDir = '';
let admin = '';
let member = '';
const PASSWORD = 'jukebox-test';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
const page = (cookie: string) => ({ cookie, origin: base });
const songs = async (cookie: string) => (await (await fetch(`${base}/api/jukebox/songs`, { headers: { cookie } })).json()) as { songs: JukeboxSong[]; total: number };
const upload = (cookie: string, name: string, body: string, headers: Record<string, string> = page(cookie)) =>
  fetch(`${base}/api/jukebox/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'content-type': 'audio/mpeg' }, body });
const remove = (file: string, headers: Record<string, string>) => fetch(`${base}/api/jukebox/delete?file=${encodeURIComponent(file)}`, { method: 'POST', headers });

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-office-jukebox-'));
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const publicDir = path.join(tmp, 'public');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, project, publicDir, path.join(publicDir, 'assets'), bin, path.join(tmp, 'projects')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(project, 'README.md'), '# jukebox\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: project });
  }
  for (const p of ['index', 'login', 'claim', 'join', 'lite']) writeFileSync(path.join(publicDir, `${p}.html`), `<!doctype html><title>${p}</title>`);
  const claude = path.join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o755);

  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_OFFICE_')) delete process.env[k];
  const port = await freePort();
  const cfg = loadConfig([project, '--home', home, '--projects', path.join(tmp, 'projects'), '--port', String(port), '--password', PASSWORD, '--no-open', '--weather', 'clear', '--agent', claude]);
  dataDir = cfg.dataDir;
  office = await startServer(cfg, { publicDir });
  base = `http://127.0.0.1:${port}`;

  // The shared password signs in as an admin; an invited member is not one.
  admin = cookieOf(await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) }));
  const invite = office.accounts.invite('test', 'member', 'Bob');
  assert.ok(typeof invite !== 'string');
  const joined = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invite.token, password: 'a long enough password' }) });
  assert.equal(joined.status, 200, await joined.clone().text());
  member = cookieOf(joined);
});

after(() => {
  office?.shutdown();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('the list of uploaded songs needs a session and starts empty', async () => {
  assert.equal((await fetch(`${base}/api/jukebox/songs`)).status, 401);
  assert.deepEqual(await songs(member), { songs: [], total: 0 });
});

test('an uploaded song is listed by its name, newest first, and plays', async () => {
  assert.equal((await upload(member, 'First Song.mp3', 'one', { cookie: member })).status, 403, 'another site cannot upload');
  assert.equal((await upload(member, 'notes.txt', 'x')).status, 415);
  const first = (await (await upload(member, 'First Song.mp3', 'one')).json()) as { file: string };
  await new Promise((r) => setTimeout(r, 20));
  const second = (await (await upload(admin, 'Kolik času.flac', 'second!')).json()) as { file: string };

  const list = await songs(member);
  assert.equal(list.total, 2);
  assert.deepEqual(list.songs.map((s) => [s.file, s.title, s.size]), [[second.file, 'Kolik casu', 7], [first.file, 'First Song', 3]]);
  assert.ok(list.songs.every((s) => s.at > Date.now() - 60_000 && s.at <= Date.now() + 1000));

  const played = await fetch(base + UPLOAD_PATH + first.file, { headers: { cookie: member, range: 'bytes=1-' } });
  assert.equal(played.status, 206);
  assert.equal(await played.text(), 'ne');
});

test('only an admin deletes a song, from the page itself, and only a song the office keeps', async () => {
  const [song] = (await songs(admin)).songs;
  const bad = async (res: Response, status: number) => assert.equal(res.status, status, await res.text());
  await bad(await remove(song.file, page(member)), 403);
  await bad(await remove(song.file, { cookie: admin }), 403);
  await bad(await remove(song.file, { origin: base }), 401);
  // Nothing outside the jukebox's folder can be named.
  writeFileSync(path.join(dataDir, 'jukebox', 'secret.txt'), 'keep me');
  for (const file of ['../accounts.json', '..\\accounts.json', `../jukebox/${song.file}`, 'secret.txt', `${song.file}/..`, '', `0123456789abcdef-missing.mp3`]) {
    await bad(await remove(file, page(admin)), 404);
  }
  assert.ok(existsSync(path.join(dataDir, 'jukebox', 'secret.txt')));
  assert.ok(!(await songs(admin)).songs.some((s) => s.file === 'secret.txt'));

  await bad(await remove(song.file, page(admin)), 200);
  assert.ok(!readdirSync(path.join(dataDir, 'jukebox')).includes(song.file));
  assert.equal((await songs(member)).total, 1);
  assert.equal((await fetch(base + UPLOAD_PATH + song.file, { headers: { cookie: member } })).status, 404);
  await bad(await remove(song.file, page(admin)), 404);
});
