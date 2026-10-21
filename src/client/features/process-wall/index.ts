import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { projectWall, WallHistory, type WallView } from './model';
import { ProcessTexture } from './texture';
import { ProcessWallPanel } from './ui';

declare module '../../world/types' {
  interface InteractKinds {
    processwall: true;
  }
}

export function installProcessWall(ctx: Ctx) {
  const texture = new ProcessTexture(), history = new WallHistory();
  const mat = ctx.office.processWall.screen.material as THREE.MeshBasicMaterial;
  mat.map = texture.texture; mat.needsUpdate = true;
  let view: WallView = 'overview', page = 0, ready = false, at = 0, lastDraw = 0, lastPanel = 0;
  const snapshot = () => projectWall({
    floor: store.currentFloor()?.name || 'Čeká na patro', workers: [...store.workers.values()], tasks: store.queue.tasks,
    pulls: store.pulls, connected: ctx.net.up, ready, at,
  });
  let current = snapshot();
  let memoryLabel = 'ověřit v detailu';
  const panel = new ProcessWallPanel(history, next => { view = next; page = 0; lastDraw = 0; }, () => { page++; lastDraw = 0; }, label => { memoryLabel = label; lastDraw = 0; });
  const refresh = () => { current = snapshot(); panel.update(current); lastDraw = 0; };
  ctx.interactions.define('processwall', {
    reach: 18,
    hint: () => ({ k: 'process-wall', parts: [hintTitle('OPORA · Řízení práce'), key('E', 'Sledovat proces')] }),
    use: onE(() => panel.open(current)),
  });
  ctx.net.onStatus(() => { ready = false; refresh(); });
  ctx.messages.onAny(message => {
    if (message.t === 'welcome' || message.t === 'floor.enter') { ready = true; history.clear(); page = 0; }
    if (!['welcome', 'floor.enter', 'worker.update', 'worker.remove', 'worker.worktree', 'queue', 'gh.pulls'].includes(message.t)) return;
    at = Date.now(); refresh(); history.observe(current); panel.update(current);
  });
  ctx.ticks.add('world', frame => {
    if (document.hidden) return;
    if (frame.now - lastPanel > 1000) { current = snapshot(); panel.update(current); lastPanel = frame.now; }
    if (!ctx.inOffice() || ctx.upTop()) return;
    if (frame.now - lastDraw < (current.running && current.connected && ready && !ctx.reduceMotion.matches ? 100 : 1000)) return;
    texture.draw(current, view, page, frame.t, ctx.reduceMotion.matches, memoryLabel); lastDraw = frame.now;
  });
  texture.draw(current, view, page, 0, true);
}
