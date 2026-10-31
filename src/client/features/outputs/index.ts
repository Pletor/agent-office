/**
 * 🗂️ Výstupy · Čistá linie: the ledge under the Čistá linie board in Boss Office. It shows how many PRs
 * went into main in the last days and how many of them have an output; E opens the list with the
 * outputs themselves, in two modes: Seznam and Deník, the project's change diary (docs/vystupy-board.md).
 * Reads `GET /api/cleanline/outputs` every minute while the tab is visible, and when its window opens.
 * The ledge always counts the last 7 days; the diary may read 30 or 90 more (a view of its own).
 */
import type * as THREE from 'three';
import { OUTPUT_DAYS, type OutputsBoard } from '../../../shared/outputs';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import type { Modal } from '../../ui/dom';
import { OutputsLedgeTexture, summary, type OutputsView } from './board';
import { openOutputs } from './detail';
import './ui.css';
import './diary.css';

declare module '../../world/types' {
  interface InteractKinds {
    outputs: true;
  }
}

export function installOutputs(ctx: Ctx) {
  let view: OutputsView = { loading: false };
  /** The diary's range, and its own view when that's not the ledge's 7 days. */
  let days = OUTPUT_DAYS;
  let wide: OutputsView = { loading: false };
  let floor: string | null = null;
  let busy: AbortController | undefined;
  let wideBusy: AbortController | undefined;
  let sig = '';
  const listeners = new Set<() => void>();
  const ledge = new OutputsLedgeTexture();
  const mat = ctx.office.outputsBoard.material as THREE.MeshBasicMaterial;
  mat.map = ledge.texture;
  mat.needsUpdate = true;

  /** Tells the ledge and the window, unless nothing they'd draw changed (the time it was read aside). */
  const emit = () => {
    const now = JSON.stringify([days, wide.loading, wide.error, wide.data?.checkedAt, view.loading, view.error, view.data ? { ...view.data, checkedAt: 0 } : null]);
    if (now === sig) return;
    sig = now;
    ledge.render(view);
    listeners.forEach((fn) => fn());
  };

  const read = (at: string, n: number, force: boolean, signal: AbortSignal) => {
    const q = new URLSearchParams({ floor: at, repo: 'floor', days: String(n), ...(force ? { refresh: '1' } : {}) });
    return fetch(`/api/cleanline/outputs?${q}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as OutputsBoard;
    });
  };

  /** The diary's wider range (30 or 90 days). */
  async function refreshWide(force = false) {
    if (wideBusy || !floor || days === OUTPUT_DAYS) return;
    const at = floor;
    const n = days;
    const request = new AbortController();
    wideBusy = request;
    try {
      const data = await read(at, n, force, request.signal);
      if (at === floor && n === days) wide = { loading: false, data };
    } catch (error) {
      if (at === floor && n === days && !request.signal.aborted) wide = { ...wide, loading: false, error: `Deník nelze načíst: ${(error as Error).message}` };
    } finally {
      if (wideBusy === request) wideBusy = undefined;
      emit();
    }
  }

  const setDays = (n: number) => {
    if (n === days) return;
    days = n;
    wideBusy?.abort();
    wideBusy = undefined;
    wide = { loading: n !== OUTPUT_DAYS };
    emit();
    void refreshWide();
  };

  /** Saves the floor's diary artifact; both views take the address the server kept. */
  async function setDiary(url: string): Promise<string | undefined> {
    if (!floor) return 'Nejprve vstup do patra kanceláře.';
    try {
      const res = await fetch(`/api/cleanline/outputs/diary?${new URLSearchParams({ floor })}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      const body = (await res.json().catch(() => ({}))) as { diaryArtifact?: string; error?: string };
      if (!res.ok) return body.error ?? `HTTP ${res.status}`;
      const put = (v: OutputsView): OutputsView => (v.data ? { ...v, data: { ...v.data, diaryArtifact: body.diaryArtifact || undefined } } : v);
      view = put(view);
      wide = put(wide);
      emit();
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async function refresh(force = false) {
    void refreshWide(force);
    if (busy || !floor) return;
    const at = floor;
    const request = new AbortController();
    busy = request;
    try {
      const data = await read(at, OUTPUT_DAYS, force, request.signal);
      if (at === floor) view = { loading: false, data };
    } catch (error) {
      if (at === floor && !request.signal.aborted) view = { ...view, loading: false, error: `Výstupy nelze načíst: ${(error as Error).message}` };
    } finally {
      if (busy === request) busy = undefined;
      emit();
    }
  }

  const scope = () => {
    if (store.floor === floor) return;
    floor = store.floor;
    busy?.abort();
    busy = undefined;
    wideBusy?.abort();
    wideBusy = undefined;
    wide = { loading: days !== OUTPUT_DAYS };
    view = floor ? { loading: true } : { loading: false, error: 'Nejprve vstup do patra kanceláře.' };
    emit();
    void refresh();
  };
  store.on('floor', scope);
  ctx.messages.on('welcome', scope);
  setInterval(() => { if (!document.hidden && floor) void refresh(); }, 60_000);

  let open: Modal | undefined;
  ctx.interactions.define('outputs', {
    reach: 4,
    hint: () => ({ k: `outputs:${summary(view)}`, parts: [hintTitle('🗂️ Výstupy · Čistá linie'), aside(`${summary(view)} · deník`), key('E', 'Co se postavilo')] }),
    use: onE(() => {
      open?.close();
      open = openOutputs({
        view: () => (days === OUTPUT_DAYS ? view : wide),
        refresh: () => void refresh(true),
        days: () => days,
        setDays,
        setDiary,
        onChange: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      });
    }),
  });
  scope();
  ledge.render(view);
}
