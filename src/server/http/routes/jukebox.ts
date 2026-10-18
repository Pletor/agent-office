// The songs people upload to the jukebox from their computers, the list of them, the ones it plays, and
// deleting one (see server/jukebox-songs.ts). Anyone signed in uploads, lists and plays; only an admin deletes.
import { createReadStream } from 'node:fs';
import { JUKEBOX_MAX_BYTES, UPLOAD_PATH, isAudioName } from '../../../shared/jukebox.js';
import type { Ctx } from '../../office/context.js';
import { str } from '../../office/input.js';
import { deleteSong, keepSong, listSongs, songFile } from '../../jukebox-songs.js';
import { readBytes, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';

/** The bytes a Range header asks for: `undefined` when there's none (or one it doesn't understand), 'bad' when it's past the end. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start > end || start >= size ? 'bad' : { start, end };
}

/** Turns off every floor's jukebox that was playing a song that's just been deleted, and tells the people there. */
function stopDeleted(ctx: Ctx, file: string, who: string) {
  for (const floor of ctx.floors.values()) {
    const j = floor.jukebox.state();
    if (!j.on || j.url !== UPLOAD_PATH + file || !floor.jukebox.stop(who)) continue;
    ctx.toFloor(floor, { t: 'jukebox', state: floor.jukebox.state() });
    ctx.toastFloor(floor, `🔇 ${who} deleted “${floor.jukebox.title()}”, so the jukebox is off`);
  }
}

export const jukeboxRoutes = {
  upload: {
    method: 'POST',
    path: '/api/jukebox/upload',
    auth: 'session',
    async handle(ctx, { req, res, url }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const tooBig = `That song is too big for the jukebox (${JUKEBOX_MAX_BYTES / 1024 / 1024} MB at most)`;
      if (Number(req.headers['content-length']) > JUKEBOX_MAX_BYTES) return send(res, 413, { error: tooBig });
      const name = str(url.searchParams.get('name'), 256);
      if (!isAudioName(name)) return send(res, 415, { error: "The jukebox plays MP3, M4A, AAC, OGG, Opus, WAV, FLAC and WebM files" });
      let body: Buffer;
      try {
        body = await readBytes(req, JUKEBOX_MAX_BYTES);
      } catch (err) {
        return (err as Error).message === 'too large' ? send(res, 413, { error: tooBig }) : send(res, 400, { error: 'Bad request' });
      }
      if (!body.length) return send(res, 400, { error: 'That song is empty' });
      const file = keepSong(ctx.cfg.dataDir, name, body);
      return file ? send(res, 200, { file }) : send(res, 500, { error: 'The office could not keep that song' });
    },
  },
  songs: {
    method: 'GET',
    path: '/api/jukebox/songs',
    auth: 'session',
    handle: (ctx, { res }) => send(res, 200, listSongs(ctx.cfg.dataDir), { 'cache-control': 'no-store' }),
  },
  remove: {
    method: 'POST',
    path: '/api/jukebox/delete',
    auth: 'session',
    handle(ctx, { req, res, url, session }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      if (!ctx.meOf(session.account?.id).admin) return send(res, 403, { error: 'Only admins can delete songs from the jukebox' });
      const file = str(url.searchParams.get('file'), 256);
      if (!songFile(ctx.cfg.dataDir, file)) return send(res, 404, { error: "The office doesn't have that song any more" });
      if (!deleteSong(ctx.cfg.dataDir, file)) return send(res, 500, { error: "The office couldn't delete that song" });
      stopDeleted(ctx, file, session.account?.name ?? 'An admin');
      return send(res, 200, { ok: true });
    },
  },
  song: {
    method: 'GET',
    prefix: UPLOAD_PATH,
    auth: 'session',
    async handle(ctx, { req, res, path: p }) {
      // Audio elements ask for ranges, so a song can be sought to where everyone else is.
      const file = songFile(ctx.cfg.dataDir, p.slice(UPLOAD_PATH.length));
      if (!file) return send(res, 404, { error: 'No such song' });
      const range = byteRange(req.headers.range, file.size);
      const head = { 'content-type': file.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
      if (range === 'bad') return res.writeHead(416, { 'content-range': `bytes */${file.size}` }).end();
      if (range) {
        res.writeHead(206, { ...head, 'content-range': `bytes ${range.start}-${range.end}/${file.size}`, 'content-length': String(range.end - range.start + 1) });
        createReadStream(file.path, range).pipe(res);
      } else {
        res.writeHead(200, { ...head, 'content-length': String(file.size) });
        createReadStream(file.path).pipe(res);
      }
    },
  },
} satisfies Record<string, Route>;
