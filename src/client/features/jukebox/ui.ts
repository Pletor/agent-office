import './ui.css';
import { AUDIO_TYPES, JUKEBOX_MAX_BYTES, JUKEBOX_TUNES, STREAM, checkStreamUrl, trackTitle, tuneById, uploadedFile } from '../../../shared/jukebox';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, toast } from '../../ui/dom';
import { songsTab, uploadSong } from './songs';

type Tab = 'tunes' | 'songs';
/** The tab the jukebox opened on last, for the next time it's opened. */
let lastTab: Tab = 'tunes';

/**
 * The jukebox: what's on, with skip and stop, and two tabs: the tunes to pick from, a box for a stream and
 * a song from your computer, and the songs people have uploaded before (songs.ts).
 */
export function openJukebox(net: Net, openVolume: () => void) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const now = h('div.jb-now');
  const list = h('ul.svc-list');
  const url = h('input', { type: 'text', placeholder: 'https://… internet radio, or a link to an .mp3', 'aria-label': 'Stream or audio file link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const playUrl = h('button.btn.primary', { type: 'button' }, '📻 Play');
  const fileIn = h('input', { type: 'file', accept: ['audio/*', ...Object.keys(AUDIO_TYPES).map((ext) => `.${ext}`)].join(','), style: 'display:none', tabindex: '-1' }) as HTMLInputElement;
  const choose = h('button.btn', { type: 'button' }, '📂 Choose a song');
  const chooseToo = h('button.btn', { type: 'button' }, '📂 Upload another song');
  const songs = songsTab(net);
  const tabTunes = h('button.jb-tab', { type: 'button', role: 'tab' }, '🎵 Tunes');
  const tabSongs = h('button.jb-tab', { type: 'button', role: 'tab' }, '📂 Uploaded songs');
  const notes = `MP3, M4A, AAC, OGG, Opus, WAV, FLAC or WebM, ${JUKEBOX_MAX_BYTES / 1024 / 1024} MB at most. The office keeps it, so it plays after a restart too, and it's under Uploaded songs for next time.`;
  const tunes = h(
    'div.jb-pane',
    {},
    h('label', {}, 'Put on a tune'),
    list,
    h('label', { style: 'margin-top:16px' }, 'Or play a stream'),
    h('div.webhook', {}, url, playUrl),
    h('p.setting-note', {}, 'Internet radio, or an audio file at a link. It plays from the jukebox, for everyone on this floor.'),
    h('label', { style: 'margin-top:16px' }, 'Or a song from your computer'),
    h('div.webhook', {}, choose, fileIn),
    h('p.setting-note', {}, notes),
  );
  const uploaded = h('div.jb-pane', {}, songs.el, h('div.webhook', { style: 'margin-top:12px' }, chooseToo));
  const volume = h('button.btn', { type: 'button' }, '🔈 Your volume');
  const el = h(
    'div.modal.jukebox',
    { role: 'dialog', 'aria-label': 'Jukebox' },
    h('header', {}, h('h2', {}, '🎵 Jukebox'), close),
    h(
      'div.body',
      {},
      now,
      h('nav.jb-tabs', { role: 'tablist', 'aria-label': 'Jukebox' }, tabTunes, tabSongs),
      tunes,
      uploaded,
    ),
    h('footer', {}, h('span.grow', {}, 'Everyone on this floor hears the same song, louder the closer they are to the lounge.'), volume),
  );

  const button = (label: string, title: string, send: () => void, primary = false) => h(primary ? 'button.btn.primary' : 'button.btn', { type: 'button', title, onclick: send }, label);

  const render = () => {
    const j = store.jukebox;
    const stream = j.track === STREAM;
    const song = uploadedFile(j.url) !== undefined;
    now.replaceChildren(
      h('span.jb-disc', { class: j.on ? 'spin' : '' }, stream && !song ? '📻' : '💿'),
      h(
        'div.svc-main',
        {},
        h('div.svc-title', {}, j.on ? trackTitle(j) : 'The jukebox is off'),
        h('div.svc-meta', {}, j.on ? [stream ? (song ? 'a song from the office' : 'a stream') : tuneById(j.track)?.mood, j.by && `put on by ${j.by}`].filter(Boolean).join(' · ') : j.by ? `${j.by} turned it off` : 'Pick a tune to put it on'),
      ),
      j.on ? button('⏭️ Skip', 'On to the next tune', () => net.send({ t: 'jukebox.skip' })) : button('▶️ Play', `Put ${trackTitle(j)} back on`, () => net.send({ t: 'jukebox.play' }), true),
      j.on ? button('⏹️ Stop', 'Turn the jukebox off', () => net.send({ t: 'jukebox.stop' })) : '',
    );
    list.replaceChildren(
      ...JUKEBOX_TUNES.map((t) => {
        const playing = j.on && j.track === t.id;
        const li = h(
          'li',
          { class: playing ? 'on' : '', tabindex: 0, role: 'button', 'aria-pressed': String(playing), title: playing ? 'Playing now' : `Put on ${t.title}` },
          h('span.jb-icon', {}, playing ? '🔊' : '🎵'),
          h('div.svc-main', {}, h('div.svc-title', {}, t.title), h('div.svc-meta', {}, t.mood)),
        );
        const pick = () => {
          if (!playing) net.send({ t: 'jukebox.play', track: t.id });
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
        return li;
      }),
    );
    songs.render();
  };

  const show = (tab: Tab) => {
    lastTab = tab;
    for (const [b, pane, id] of [[tabTunes, tunes, 'tunes'], [tabSongs, uploaded, 'songs']] as const) {
      b.classList.toggle('on', tab === id);
      b.setAttribute('aria-selected', String(tab === id));
      pane.classList.toggle('hidden', tab !== id);
    }
    if (tab === 'songs') void songs.refresh();
  };
  tabTunes.addEventListener('click', () => show('tunes'));
  tabSongs.addEventListener('click', () => show('songs'));

  const play = () => {
    const u = checkStreamUrl(url.value);
    if ('error' in u) {
      toast(u.error, 'warn');
      return url.focus();
    }
    net.send({ t: 'jukebox.play', url: u.url });
    url.value = '';
  };
  playUrl.addEventListener('click', play);
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') play();
  });

  // A song from the computer goes up to the office first; then the jukebox plays it by the name it was kept
  // under, and it's in the Uploaded songs list from then on.
  const sendSong = async (f: File) => {
    choose.disabled = chooseToo.disabled = true;
    try {
      const file = await uploadSong(f);
      if (file) net.send({ t: 'jukebox.play', file });
      await songs.refresh();
    } finally {
      choose.disabled = chooseToo.disabled = false;
      fileIn.value = '';
    }
  };
  choose.addEventListener('click', () => fileIn.click());
  chooseToo.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    if (f) void sendSong(f);
  });

  const modal = openModal(el, { doing: '🎵 at the jukebox', onClose: store.on('jukebox', render) });
  close.addEventListener('click', () => modal.close());
  volume.addEventListener('click', () => {
    modal.close();
    openVolume();
  });
  render();
  show(lastTab);
}
