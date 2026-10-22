import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { watchProcessGaps } from './catchup';
import { buildBoard, LaneResolver, type Board, type BoardInput } from './lanes';
import { lastEventLabel, liveness, sourceHealth, type Liveness } from './live';
import { WallMotion } from './motion';
import { ProcessTexture } from './texture';
import { ProcessWallPanel } from './ui';
import type { PanelData } from './view';

declare module '../../world/types' {
  interface InteractKinds {
    processwall: true;
  }
}

/**
 * The live process wall and its window. Everything is computed from the floor's process journal
 * and the store, again only when one of them (or the connection) changes; the wall is redrawn then,
 * while a marker still moves, and when the once-a-second age label reads differently.
 */
export function installProcessWall(ctx: Ctx) {
  const texture = new ProcessTexture(), motion = new WallMotion();
  const mat = ctx.office.processWall.screen.material as THREE.MeshBasicMaterial;
  mat.map = texture.texture; mat.needsUpdate = true;
  let memory: { label: string; ok: boolean; at: number } | undefined;
  const input = (): BoardInput => ({
    events: store.process.events, workers: [...store.workers.values()], tasks: store.queue.tasks,
    pulls: store.pulls.items, runs: store.opora.runs, cards: store.opora.cards,
  });
  const panel = new ProcessWallPanel(() => new LaneResolver(input()), (label, ok) => { memory = { label, ok, at: Date.now() }; panel.tick(health()); });
  let board: Board = buildBoard(input());
  let live: Liveness = liveOf(Date.now());
  let age = '';
  let dirty = true;

  function liveOf(now: number) {
    return liveness({ up: ctx.net.up, synced: store.process.connected, lastAt: board.lastAt, anyWorking: board.counts.working > 0, now });
  }
  function health() {
    const o = store.opora;
    return sourceHealth({ up: ctx.net.up, events: store.process.events, opora: { connected: o.connected, linked: !!o.project }, stream: store.process.stream, github: store.pulls, memory, now: Date.now() });
  }
  const data = (): PanelData => ({ board, events: store.process.events, health: health(), floor: store.currentFloor()?.name ?? '—', reduced: ctx.reduceMotion.matches });
  let frame = 0;
  /** Any number of changes in one frame redraw once. */
  function refresh() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; redraw(); });
  }
  function redraw() {
    board = buildBoard(input());
    live = liveOf(Date.now());
    motion.observe(board.lanes, performance.now(), ctx.reduceMotion.matches);
    dirty = true;
    panel.update(data());
  }

  ctx.interactions.define('processwall', {
    reach: 18,
    hint: () => ({ k: 'process-wall', parts: [hintTitle('OPORA · Živý proces'), key('E', 'Sledovat proces')] }),
    use: onE(() => panel.show(data())),
  });
  for (const topic of ['process', 'workers', 'queue', 'pulls', 'opora'] as const) store.on(topic, refresh);
  ctx.net.onStatus(refresh);
  ctx.messages.onAny((m) => {
    if (m.t === 'welcome' || m.t === 'floor.enter') { motion.reset(); refresh(); }
  });

  let lastSecond = 0, settling = false;
  ctx.ticks.add('world', (frame) => {
    if (document.hidden) return;
    if (frame.now - lastSecond >= 1000) {
      lastSecond = frame.now;
      const now = Date.now(), nextLive = liveOf(now), nextAge = lastEventLabel(board.lastAt, now);
      if (nextAge !== age || nextLive.state !== live.state || nextLive.reason !== live.reason) { age = nextAge; live = nextLive; dirty = true; }
      panel.tick(health());
    }
    // One more frame after the motion ends, so markers settle exactly on their phase.
    const moving = motion.active(performance.now());
    if (!dirty && !moving && !settling) return;
    if (!ctx.inOffice() || ctx.upTop()) return;
    settling = moving;
    age = lastEventLabel(board.lastAt, Date.now());
    texture.draw({ board, live, age, reduced: ctx.reduceMotion.matches, now: performance.now() }, motion);
    dirty = false;
  });
  watchProcessGaps(ctx);
  redraw();
}
