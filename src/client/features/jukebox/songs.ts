// The jukebox's "Uploaded songs" tab: the songs the office keeps (server/jukebox-songs.ts), newest first.
// One click plays one for the floor; an admin can delete one, after saying so in the row itself.
import { JUKEBOX_MAX_BYTES, isAudioName, uploadedFile, type JukeboxSong } from '../../../shared/jukebox';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, toast } from '../../ui/dom';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Sends a song from the computer up to the office, which keeps it; the name it was kept under, or
 * undefined (having said why) when it couldn't be.
 */
export async function uploadSong(f: File): Promise<string | undefined> {
  if (!isAudioName(f.name)) {
    toast('The jukebox plays MP3, M4A, AAC, OGG, Opus, WAV, FLAC and WebM files', 'warn');
    return undefined;
  }
  if (f.size > JUKEBOX_MAX_BYTES) {
    toast(`That song is too big for the jukebox (${JUKEBOX_MAX_BYTES / 1024 / 1024} MB at most)`, 'warn');
    return undefined;
  }
  toast(`Uploading “${f.name}”…`);
  try {
    const res = await fetch(`/api/jukebox/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
    const body = (await res.json().catch(() => ({}))) as { file?: string; error?: string };
    if (res.ok && body.file) return body.file;
    toast(body.error ?? "The office couldn't keep that song", 'warn');
  } catch {
    toast("Couldn't upload that song. Check your connection and try again", 'warn');
  }
  return undefined;
}

/** The tab's contents, `render` for when what's on changes, and `refresh` to ask the office for the list again. */
export function songsTab(net: Net) {
  const list = h('ul.svc-list.jb-songs');
  const count = h('p.setting-note');
  const el = h('div.jb-songs-tab', {}, list, count);
  let songs: JukeboxSong[] | undefined;
  let total = 0;
  let failed = false;
  /** The song whose row is asking "Delete it?", if one is. */
  let confirming: string | undefined;

  const remove = async (s: JukeboxSong) => {
    try {
      const res = await fetch(`/api/jukebox/delete?file=${encodeURIComponent(s.file)}`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) toast(body.error ?? "The office couldn't delete that song", 'warn');
      else toast(`🗑️ Deleted “${s.title}”`);
    } catch {
      toast("Couldn't delete that song. Check your connection and try again", 'warn');
    }
    confirming = undefined;
    await refresh();
  };

  const row = (s: JukeboxSong) => {
    const j = store.jukebox;
    const playing = j.on && uploadedFile(j.url) === s.file;
    const btn = (label: string, title: string, run: () => void, cls: 'button.btn' | 'button.btn.danger' = 'button.btn') =>
      h(cls, {
        type: 'button',
        title,
        onclick: (e: Event) => {
          e.stopPropagation();
          run();
        },
      }, label);
    const actions =
      !store.me.admin ? []
      : confirming === s.file ? [h('span.jb-ask', {}, 'Delete it?'), btn('🗑️ Delete', `Delete ${s.title} from the office`, () => void remove(s), 'button.btn.danger'), btn('Keep', 'Keep it', () => ((confirming = undefined), render()))]
      : [btn('🗑️', `Delete ${s.title}…`, () => ((confirming = s.file), render()))];
    const li = h(
      'li',
      { class: playing ? 'on' : '', tabindex: 0, role: 'button', 'aria-pressed': String(playing), title: playing ? 'Playing now' : `Put on ${s.title}` },
      h('span.jb-icon', {}, playing ? '🔊' : '💿'),
      h('div.svc-main', {}, h('div.svc-title', {}, s.title), h('div.svc-meta', {}, [mb(s.size), day(s.at), playing ? 'playing now' : ''].filter(Boolean).join(' · '))),
      ...actions,
    );
    const pick = () => {
      if (!playing) net.send({ t: 'jukebox.play', file: s.file });
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => {
      if (e.target === li && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        pick();
      }
    });
    return li;
  };

  const render = () => {
    if (!songs) {
      list.replaceChildren(h('li.jb-empty', {}, failed ? "Couldn't load the songs. Open the tab again to try again" : 'Loading the songs…'));
      count.textContent = '';
      return;
    }
    list.replaceChildren(...(songs.length ? songs.map(row) : [h('li.jb-empty', {}, 'No songs yet. Choose one from your computer and the office keeps it here.')]));
    count.textContent = [
      total > songs.length ? `The newest ${songs.length} of ${total} songs.` : '',
      store.me.admin ? 'Admins can delete a song.' : 'Only an admin can delete a song.',
    ].filter(Boolean).join(' ');
  };

  const refresh = async () => {
    try {
      const res = await fetch('/api/jukebox/songs');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { songs: JukeboxSong[]; total: number };
      songs = body.songs;
      total = body.total;
      failed = false;
      if (confirming && !songs.some((s) => s.file === confirming)) confirming = undefined;
    } catch {
      failed = true;
    }
    render();
  };

  render();
  return { el, render, refresh };
}
