import type { GraphRow } from '../../../shared/cleanline';

/** Lane colors: main is the office's teal, branches take the rest in turn. */
export const LANE_COLORS = ['#06d6a0', '#f6bd60', '#4cc9f0', '#ef476f', '#b388eb', '#ffd166', '#90be6d', '#f28482'];
export const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

export interface GraphGeometry {
  /** Where lane `l`'s line runs, and where row `i`'s node sits. */
  x(lane: number): number;
  y(row: number): number;
  rowH: number;
  dot: number;
}

/**
 * Draws the lanes and nodes of `rows` (see layoutGraph) on a 2D canvas: straight lines for lanes
 * passing by, curves where a branch leaves or joins, a ring for a merge commit.
 */
export function paintGraph(g: CanvasRenderingContext2D, rows: readonly GraphRow[], geo: GraphGeometry, line = 3) {
  g.lineWidth = line;
  g.lineCap = 'round';
  const seg = (lane: number, y0: number, y1: number) => {
    g.strokeStyle = laneColor(lane);
    g.beginPath();
    g.moveTo(geo.x(lane), y0);
    g.lineTo(geo.x(lane), y1);
    g.stroke();
  };
  const curve = (from: number, y0: number, to: number, y1: number, color: number) => {
    g.strokeStyle = laneColor(color);
    g.beginPath();
    g.moveTo(geo.x(from), y0);
    const mid = (y0 + y1) / 2;
    g.bezierCurveTo(geo.x(from), mid, geo.x(to), mid, geo.x(to), y1);
    g.stroke();
  };
  const half = geo.rowH / 2;
  rows.forEach((r, i) => {
    const y = geo.y(i);
    for (const l of r.through) seg(l, y - half, y + half);
    if (r.fromAbove) seg(r.lane, y - half, y);
    for (const l of r.merging) curve(l, y - half, r.lane, y, l);
    for (const l of r.toParents) {
      if (l === r.lane) seg(l, y, y + half);
      else curve(r.lane, y, l, y + half, Math.max(l, r.lane));
    }
    if (r.cut) seg(r.lane, y, y + half * 0.6);
  });
  rows.forEach((r, i) => {
    const y = geo.y(i);
    g.fillStyle = laneColor(r.lane);
    g.beginPath();
    g.arc(geo.x(r.lane), y, geo.dot, 0, Math.PI * 2);
    g.fill();
    if (r.parents.length > 1) {
      g.fillStyle = '#142337';
      g.beginPath();
      g.arc(geo.x(r.lane), y, geo.dot * 0.45, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/** "před 3 h": how long ago, in Czech, from seconds since the epoch. */
export function ago(sec: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - sec * 1000) / 60_000));
  if (m < 60) return `před ${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `před ${hrs} h`;
  return `před ${Math.round(hrs / 24)} d`;
}
