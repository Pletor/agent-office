/**
 * 🗂️ Výstupy · Čistá linie: the ledge under the Čistá linie board in Boss Office. It shows how many PRs
 * went into main in the last days and how many of them have an output; E opens the list with the
 * outputs themselves (docs/vystupy-board.md). Reads `GET /api/cleanline/outputs` every minute while the
 * tab is visible, and when its window opens.
 */
import type * as THREE from 'three';
import type { OutputsBoard } from '../../../shared/outputs';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import type { Modal } from '../../ui/dom';
import { OutputsLedgeTexture, summary, type OutputsView } from './board';
import { openOutputs } from './detail';
import './ui.css';

declare module '../../world/types' {
  interface InteractKinds {
    outputs: true;
  }
}

export function installOutputs(ctx: Ctx) {
  let view: OutputsView = { loading: false };
  let floor: string | null = null;
  let busy: AbortController | undefined;
  let sig = '';
  const listeners = new Set<() => void>();
  const ledge = new OutputsLedgeTexture();
  const mat = ctx.office.outputsBoard.material as THREE.MeshBasicMaterial;
  mat.map = ledge.texture;
  mat.needsUpdate = true;

  /** Tells the ledge and the window, unless nothing they'd draw changed (the time it was read aside). */
  const emit = () => {
    const now = JSON.stringify([view.loading, view.error, view.data ? { ...view.data, checkedAt: 0 } : null]);
    if (now === sig) return;
    sig = now;
    ledge.render(view);
    listeners.forEach((fn) => fn());
  };

  async function refresh(force = false) {
    if (busy || !floor) return;
    const at = floor;
    const request = new AbortController();
    busy = request;
    try {
      const q = new URLSearchParams({ floor: at, repo: 'floor', ...(force ? { refresh: '1' } : {}) });
      const res = await fetch(`/api/cleanline/outputs?${q}`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OutputsBoard;
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
    hint: () => ({ k: `outputs:${summary(view)}`, parts: [hintTitle('🗂️ Výstupy · Čistá linie'), aside(summary(view)), key('E', 'Co se postavilo')] }),
    use: onE(() => {
      open?.close();
      open = openOutputs({
        view: () => view,
        refresh: () => void refresh(true),
        onChange: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      });
    }),
  });
  scope();
  ledge.render(view);
}
