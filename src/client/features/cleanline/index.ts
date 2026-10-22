import type * as THREE from 'three';
import type { CleanLine } from '../../../shared/cleanline';
import type { Ctx } from '../../core/context';
import { hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { LineController } from './controller';
import { LineScreen } from './screen';
import { openCleanLine } from './ui';

declare module '../../world/types' {
  interface InteractKinds {
    cleanline: true;
  }
}

/** Čistá linie: the Boss Office board of main, its branches, the merge queue and the tidying up. */
export function installCleanLine(ctx: Ctx) {
  const controller = new LineController(async (floor, repo, force, signal) => {
    const q = new URLSearchParams({ floor, repo, ...(force ? { refresh: '1' } : {}) });
    const res = await fetch(`/api/cleanline?${q}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CleanLine;
  });
  const screen = new LineScreen();
  const mat = ctx.office.cleanLineBoard.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  // Drawn again only when what it shows changed (the controller says so).
  controller.onChange(() => screen.render(controller.view));
  const scope = () => controller.setScope(store.floor);
  store.on('floor', scope);
  ctx.messages.on('welcome', scope);
  setInterval(() => { if (!document.hidden && store.floor) void controller.refresh(); }, 15_000);
  ctx.interactions.define('cleanline', {
    reach: 4,
    hint: () => ({ k: 'cleanline', parts: [hintTitle('Čistá linie — Boss Office'), key('E', 'Otevřít tabuli')] }),
    use: onE(() => openCleanLine(controller)),
  });
  scope();
  screen.render(controller.view);
}
