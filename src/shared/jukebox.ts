// The lounge jukebox: the tunes it has and what it's playing, shared by the server (which keeps one
// per floor) and the browser (which synthesizes the tunes, see client/sound/music.ts).

export interface JukeboxTune {
  id: string;
  title: string;
  /** A few words on the card in its list. */
  mood: string;
}

export const JUKEBOX_TUNES: readonly JukeboxTune[] = [
  { id: 'rainy-window', title: 'Rainy Window', mood: 'slow and dreamy' },
  { id: 'coffee-break', title: 'Coffee Break', mood: 'jazzy, easy swing' },
  { id: 'late-commit', title: 'Late Commit', mood: 'minor key, 2 a.m.' },
  { id: 'green-build', title: 'Green Build', mood: 'bright and bouncy' },
];

/** The `track` of a stream someone pasted, or a song uploaded from their computer. */
export const STREAM = 'stream';

/** The biggest song that can be uploaded: a long mix or a lossless track fits, a whole album doesn't. */
export const JUKEBOX_MAX_BYTES = 200 * 1024 * 1024;

/** Where the office serves an uploaded song: `UPLOAD_PATH` + the name it was kept under (see uploadName). */
export const UPLOAD_PATH = '/api/jukebox/file/';

/** The audio files the jukebox plays, by extension, and the type each is served as. */
export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

/**
 * What a song is kept as, from the name it had on the computer: a random 16-hex id (so nobody can
 * guess another's), a dash, and the name's letters, digits, dots and dashes, ending in its audio
 * extension. Undefined when it isn't an audio file the jukebox can play.
 */
export function uploadName(name: string, id: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!Object.hasOwn(AUDIO_TYPES, ext)) return undefined;
  const stem = base
    .slice(0, dot)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${id}-${stem || 'song'}.${ext}`;
}

/** Whether a file someone picked is an audio file the jukebox can play, by its name. */
export const isAudioName = (name: string): boolean => uploadName(name, '0'.repeat(16)) !== undefined;

/** The kept name in an upload path (see uploadName), or undefined for anything else, a stream included. */
export function uploadedFile(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.startsWith(UPLOAD_PATH)) return undefined;
  const file = url.slice(UPLOAD_PATH.length);
  const ext = file.slice(file.lastIndexOf('.') + 1);
  return /^[0-9a-f]{16}-[\w.-]{1,120}\.[a-z0-9]{2,4}$/.test(file) && Object.hasOwn(AUDIO_TYPES, ext) ? file : undefined;
}

/** What an uploaded song is called: its name as it was on the computer, without the id or the extension. */
export function uploadTitle(file: string): string {
  return file.slice(17).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'A song';
}

/** The most uploaded songs the jukebox's list shows, newest first; older ones are still kept and played. */
export const JUKEBOX_LIST_MAX = 200;

/** A song the office keeps, as the jukebox's "Uploaded songs" tab lists it (GET /api/jukebox/songs). */
export interface JukeboxSong {
  /** The name it's kept under (see uploadName): what `jukebox.play` takes as `file`. */
  file: string;
  /** Its name as it was on the computer (see uploadTitle). */
  title: string;
  /** In bytes. */
  size: number;
  /** When it was uploaded, in ms. */
  at: number;
}

export interface JukeboxState {
  on: boolean;
  /** One of JUKEBOX_TUNES, or STREAM for `url`. It stays put while the jukebox is off, to turn back on. */
  track: string;
  /** Internet radio or an audio file someone pasted. */
  url?: string;
  /** Who last put something on, or turned it off. */
  by?: string;
  /** When the track started, on the office's clock (see the 'pong' message), so everyone hears the same bar. */
  startedAt: number;
  /** How far into the track it was when this was sent, in ms, for until the clocks are compared. */
  elapsed: number;
}

export const tuneById = (id: string): JukeboxTune | undefined => JUKEBOX_TUNES.find((t) => t.id === id);

/** What's on, for the hint bar and the jukebox's own display: a tune's title, or where the stream comes from. */
export function trackTitle(s: Pick<JukeboxState, 'track' | 'url'>): string {
  if (s.track !== STREAM) return tuneById(s.track)?.title ?? 'A tune';
  const file = uploadedFile(s.url);
  if (file) return uploadTitle(file);
  try {
    const u = new URL(s.url ?? '');
    const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return file ? `${u.hostname} · ${file}` : u.hostname;
  } catch {
    return 'A stream';
  }
}

export function checkStreamUrl(raw: unknown): { url: string } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { error: 'Paste a link to a stream or an audio file' };
  if (s.length > 2048) return { error: 'That link is too long' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "That isn't a web link. Paste an address that starts with https://" };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http and https links can play on the jukebox' };
  return { url: u.href };
}

/** A stream link someone pasted, or the path of a song uploaded to this office (see uploadName). */
export function checkJukeboxUrl(raw: unknown): { url: string } | { error: string } {
  const file = uploadedFile(typeof raw === 'string' ? raw.trim() : raw);
  return file ? { url: UPLOAD_PATH + file } : checkStreamUrl(raw);
}
