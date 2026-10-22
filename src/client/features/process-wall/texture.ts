// The wall itself: a 2048×512 canvas on the north wall. Top bar (title, counts, live pill and the
// age of the last event), the seven phases with their counts, up to five lanes (blockers first, then
// the most recently active) and the blocker band. It is drawn only when something changed.

import * as THREE from 'three';
import { PHASE_CZ, type Board, type Lane } from './lanes';
import type { Liveness } from './live';
import type { WallMotion } from './motion';
import { C, chip, dot, fit, font, ring, rrect, text, trailDot, type G } from './paint';

export const WALL_W = 2048;
export const WALL_H = 512;
const PAD_X = 40;
const TOP = 24;
const BAR_H = 78;
const PH_Y = TOP + BAR_H + 8;
const PH_H = 40;
const LANES_Y = PH_Y + PH_H + 8;
const BAND_H = 50;
const BAND_Y = WALL_H - 22 - BAND_H;
const LANES_H = BAND_Y - 8 - LANES_Y;
export const WALL_LANES = 5;
const LANE_H = LANES_H / WALL_LANES;
const LABEL_W = 520;
const GRID_X = PAD_X + LABEL_W;
const COL = (WALL_W - PAD_X - GRID_X) / 7;
const cx = (phase: number) => GRID_X + COL * (phase + 0.5);

export interface WallScene {
  board: Board;
  live: Liveness;
  age: string;
  reduced: boolean;
  now: number;
}

const MARKER: Record<string, string> = { info: C.info, ok: C.ok, wait: C.warn, fail: C.bad, blocked: C.bad };

export class ProcessTexture {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  constructor() {
    this.canvas.width = WALL_W;
    this.canvas.height = WALL_H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  draw(s: WallScene, motion: WallMotion) {
    const g = this.canvas.getContext('2d')!;
    g.globalAlpha = 1;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, WALL_W, WALL_H);
    this.topBar(g, s);
    const shown = s.board.lanes.slice(0, WALL_LANES);
    this.phases(g, s, shown.length);
    if (!s.board.lanes.length) this.empty(g);
    const stale = s.live.state !== 'live';
    shown.forEach((lane, i) => this.lane(g, lane, LANES_Y + i * LANE_H, stale, s, motion));
    this.band(g, s.board);
    if (stale && s.live.reason) this.overlay(g, s.live.reason);
    this.texture.needsUpdate = true;
  }

  private topBar(g: G, s: WallScene) {
    const y = TOP + BAR_H / 2;
    let x = PAD_X + text(g, 'OPORA · ŽIVÝ PROCES', PAD_X, y, 34, C.ink) + 44;
    const c = s.board.counts;
    const counts: [number, string, string][] = [[c.cards, 'karet', C.ink]];
    if (c.cards) counts.push([c.working, 'pracuje', C.info], [c.waiting, 'čeká na vás', C.warn], [c.failed, 'selhalo', C.bad]);
    for (const [n, label, color] of counts) {
      x += text(g, String(n), x, y + 2, 54, color) + 10;
      x += text(g, label, x, y + 10, 24, C.dim, 800) + 40;
    }
    // Right: the pill and the age of the last event.
    const right = WALL_W - PAD_X;
    const ageW = text(g, s.age, right, y, 26, C.dim, 800, 'right');
    font(g, 30);
    const pillText = s.live.label;
    const pillW = g.measureText(pillText).width + 16 + 20 + 12 + 22;
    const px = right - ageW - 18 - pillW, ph = 58;
    const color = s.live.state === 'live' ? C.ok : s.live.state === 'off' ? C.bad : C.warn;
    rrect(g, px, y - ph / 2, pillW, ph, ph / 2);
    g.strokeStyle = color; g.lineWidth = 4; g.stroke();
    if (s.live.state === 'live') dot(g, px + 26, y, 10, color);
    else ring(g, px + 26, y, 8, color, 4);
    text(g, pillText, px + 16 + 20 + 12, y + 1, 30, color);
  }

  private phases(g: G, s: WallScene, shown: number) {
    const y = PH_Y + PH_H / 2, b = s.board;
    if (b.lanes.length) {
      const note = s.live.state === 'live' ? 'nejdřív blokace' : 'poslední známý stav';
      font(g, 22, 800);
      text(g, fit(g, `${shown} z ${b.lanes.length} karet · ${note}`, LABEL_W - 30), PAD_X, y, 22, C.dim, 800);
    }
    PHASE_CZ.forEach((name, i) => {
      font(g, 24);
      const label = name.toUpperCase(), count = b.phaseCounts[i];
      const lw = g.measureText(label).width;
      font(g, 20);
      const cw = count ? g.measureText(String(count)).width + 18 : 0;
      const total = 32 + 10 + lw + (count ? 10 + cw : 0);
      let x = cx(i) - total / 2;
      dot(g, x + 16, y, 16, C.bg3);
      text(g, String(i + 1), x + 16, y + 1, 18, C.ink, 900, 'center');
      x += 42;
      text(g, label, x, y + 1, 24, C.dim);
      x += lw + 10;
      if (count) {
        rrect(g, x, y - 13, cw, 26, 12); g.fillStyle = C.info; g.fill();
        text(g, String(count), x + cw / 2, y + 1, 20, C.bg, 900, 'center');
      }
    });
  }

  private empty(g: G) {
    const y = LANES_Y + LANES_H / 2;
    text(g, 'Zatím žádná událost', WALL_W / 2, y - 22, 34, C.dim, 900, 'center');
    text(g, 'kancelář ani Opora nic nehlásí', WALL_W / 2, y + 24, 24, C.dim, 800, 'center');
  }

  private lane(g: G, lane: Lane, top: number, stale: boolean, s: WallScene, motion: WallMotion) {
    const y = top + LANE_H / 2;
    g.fillStyle = C.bg2;
    g.fillRect(PAD_X, top, WALL_W - PAD_X * 2, 2);
    g.save();
    if (stale) g.globalAlpha = 0.5;
    // Label: id chip and name.
    const chipW = chip(g, lane.chip, PAD_X, y, 22, C.ink, C.bg3);
    font(g, 28, 800);
    const name = fit(g, lane.name, LABEL_W - chipW - 14 - 18);
    text(g, name, PAD_X + chipW + 14, y, 28, lane.blocker ? C.pink : C.ink, 800);
    // Track: the past part brighter.
    const at = motion.phaseAt(lane.key, lane.phase, s.now);
    g.fillStyle = C.line;
    g.fillRect(cx(0), y - 2, cx(6) - cx(0), 4);
    if (lane.marker !== 'none') { g.fillStyle = C.past; g.fillRect(cx(0), y - 2, cx(at) - cx(0), 4); }
    // Trail: a phase passed without an event is dashed, but only after the lane's first event.
    const first = lane.trail.findIndex((m) => m);
    lane.trail.forEach((mark, i) => {
      if (i === lane.phase && lane.marker !== 'none') return;
      if (i < lane.phase) { if (mark || i > first) trailDot(g, cx(i), y, mark ?? 'skip'); }
      else if (mark) trailDot(g, cx(i), y, mark, 0.4);
    });
    this.marker(g, lane, cx(at) + motion.shake(lane.key, s.now), y, stale, motion.pulse(lane.key, s.now));
    g.restore();
  }

  private marker(g: G, lane: Lane, x: number, y: number, stale: boolean, pulse: number) {
    const r = 25;
    if (lane.marker === 'none') {
      dot(g, x, y, r, C.bg); ring(g, x, y, r - 1.5, C.past, 3, [7, 5]);
      text(g, '—', x, y + 1, 19, C.dim, 900, 'center');
      return;
    }
    const color = stale ? C.past : MARKER[lane.marker];
    if (pulse >= 0) {
      g.save(); g.globalAlpha *= 0.6 * (1 - pulse);
      ring(g, x, y, r + 8 + 18 * pulse, C.info, 4);
      g.restore();
    }
    dot(g, x, y, r + 8, color);
    dot(g, x, y, r + 4, C.bg);
    const blocked = lane.marker === 'blocked';
    dot(g, x, y, r, stale ? C.bg3 : blocked ? C.bg : color);
    text(g, lane.initials, x, y + 1, 19, stale ? C.dim : blocked ? C.bad : C.bg, 900, 'center');
    if (lane.blocker?.human && !stale) {
      dot(g, x + 25, y - 23, 13, C.bad);
      text(g, '!', x + 25, y - 22, 19, C.bg, 900, 'center');
    }
  }

  private band(g: G, b: Board) {
    const calm = !b.blockers.length;
    rrect(g, PAD_X, BAND_Y, WALL_W - PAD_X * 2, BAND_H, 12);
    g.fillStyle = calm ? '#10302a' : '#3a1622'; g.fill();
    const y = BAND_Y + BAND_H / 2;
    let x = PAD_X + 18;
    x += chip(g, calm ? 'BEZ BLOKACÍ' : `BLOKACE ${b.blockers.length}`, x, y, 22, C.bg, calm ? C.ok : C.bad, 12, 32) + 18;
    const end = WALL_W - PAD_X - 18;
    for (const blk of b.blockers) {
      font(g, 25);
      const idW = g.measureText(blk.chip).width;
      font(g, 25, 800);
      const tw = g.measureText(blk.text).width;
      if (x + idW + 8 + tw > end) {
        text(g, '…', x, y, 25, C.dim);
        break;
      }
      text(g, blk.chip, x, y, 25, C.pink);
      text(g, blk.text, x + idW + 8, y, 25, C.ink, 800);
      x += idW + 8 + tw + 22;
    }
  }

  private overlay(g: G, reason: string) {
    font(g, 30);
    const w = Math.min(g.measureText(reason).width + 52, WALL_W - 640 - PAD_X), h = 64;
    const x = 600 + (WALL_W - 600 - PAD_X - w) / 2, y = LANES_Y + LANES_H / 2 - h / 2 + 10;
    rrect(g, x, y, w, h, 16);
    g.fillStyle = 'rgba(15,19,32,.92)'; g.fill();
    g.strokeStyle = C.bad; g.lineWidth = 4; g.stroke();
    text(g, fit(g, reason, w - 52), x + w / 2, y + h / 2 + 1, 30, C.ink, 900, 'center');
  }
}
