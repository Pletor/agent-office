// The Lens diagram's layout: a pure function of the graph, the width and the switches, no DOM.
// Lanes are stacked bands; each lane's cards sit in rows of 3 (2 below 370 px), ordered by their
// first appearance in the flows, then by the spec. Edges are orthogonal and rounded: they run in the
// gaps under the card rows (one 20 px track per edge, so their labels never overlap), drop straight
// through when nothing is in the way, and take a strip on the right margin when a card is.

import type { LensEdge, LensGraph, LensLane, LensNode } from '../../../shared/opora-lens';

export const K = { HEAD: 26, TRACK: 20, GAP: 8, PADX: 6, CARD: 56, FILE: 14, ARROW: 7 } as const;

export interface LayoutOpts {
  /** Show the edges found in code (Graphify). */
  code: boolean;
  /** Only changed cards and the ends of changed edges. */
  changed: boolean;
  /** Cards one line taller, with their first file path. */
  files: boolean;
}

export interface LayoutNode { n: LensNode; lane: LensLane; row: number; col: number; ghost: boolean; x: number; y: number; w: number; h: number }
export interface LayoutEdge {
  e: LensEdge;
  /** The polyline's corners, from the source card's side to the target card's side. */
  pts: [number, number][];
  /** SVG path data: the polyline with rounded corners, ending where the arrowhead starts. */
  d: string;
  /** SVG path data of the arrowhead. */
  head: string;
  /** Where the label goes: the middle of the first horizontal run. */
  label: { x: number; y: number };
  /** The gap (under row `corridor`) and track the first horizontal run is in. */
  corridor: number;
  track: number;
}
export interface LensLayout { W: number; H: number; cols: number; nodes: LayoutNode[]; edges: LayoutEdge[]; bands: { lane: LensLane; y: number; h: number }[]; hidden: number }

interface Row { lane: LensLane; first: boolean; last: boolean; nodes: LensNode[]; y?: number }
interface Box { x: number; y: number; w: number; h: number; row: number }
interface Route { e: LensEdge; a: { row: number }; b: { row: number }; dir: number; out: 't' | 'b'; in: 't' | 'b'; sx: number; tx: number; gx?: number; cs: number[]; tr: number[] }

export function layoutLens(g: LensGraph, W: number, o: LayoutOpts): LensLayout {
  const all = new Map<string, { n: LensNode; lane: LensLane }>();
  for (const l of g.lanes) for (const n of l.nodes) if (!all.has(n.id)) all.set(n.id, { n, lane: l });
  // 1. What is shown: code edges on request; "only changed" keeps changed cards plus the ends of changed edges.
  let edges = g.edges.filter((e) => all.has(e.from) && all.has(e.to) && e.from !== e.to && (o.code || !e.code));
  let keep: Set<string> | null = null;
  if (o.changed) {
    const k = (keep = new Set([...all.values()].filter((v) => v.n.delta !== 'unchanged').map((v) => v.n.id)));
    edges = edges.filter((e) => e.delta !== 'unchanged' || (k.has(e.from) && k.has(e.to)));
    for (const e of edges) { k.add(e.from); k.add(e.to); }
  }
  // 2. Order inside a lane: first appearance in the flows, then spec order.
  const rank = new Map<string, number>();
  for (const f of g.flows) for (const s of f.steps) for (const id of [s.from, s.to]) if (id && !rank.has(id)) rank.set(id, rank.size);
  const cols = W >= 370 ? 3 : 2;
  const rows: Row[] = [];
  const at = new Map<string, { n: LensNode; lane: LensLane; row: number; col: number; ghost: boolean }>();
  for (const l of g.lanes) {
    const ns = l.nodes.filter((n) => all.get(n.id)?.lane === l && (!keep || keep.has(n.id)))
      .map((n, i) => ({ n, r: rank.get(n.id) ?? 1e6 + i })).sort((a, b) => a.r - b.r).map((x) => x.n);
    for (let i = 0; i < ns.length; i += cols) {
      const row: Row = { lane: l, first: i === 0, last: i + cols >= ns.length, nodes: ns.slice(i, i + cols) };
      row.nodes.forEach((n, c) => at.set(n.id, { n, lane: l, row: rows.length, col: c, ghost: !!keep && n.delta === 'unchanged' }));
      rows.push(row);
    }
  }
  // 3. Every edge runs in the gaps under card rows. Neighbour rows or the same row: the one gap
  //    between them. Skipping rows: straight down/up when no card is in the way, else two gaps and the
  //    right-hand strip.
  const R: Route[] = edges.map((e) => {
    const a = at.get(e.from)!, b = at.get(e.to)!;
    const dir = Math.sign(b.row - a.row);
    return { e, a, b, dir, out: dir < 0 ? 't' : 'b', in: dir > 0 ? 't' : 'b', sx: 0, tx: 0, cs: [], tr: [] };
  });
  const ch = K.CARD + (o.files ? K.FILE : 0);
  let box = new Map<string, Box>();
  let strips = 0;
  for (let pass = 0; pass < 4; pass++) {
    // 4. Card boxes: equal columns, short rows centred, the strip kept free on the right.
    const gut = strips ? 6 + strips * 7 : 0;
    const cw = (W - gut - 2 * K.PADX - (cols - 1) * K.GAP) / cols;
    box = new Map();
    rows.forEach((row, ri) => {
      const off = ((cols - row.nodes.length) * (cw + K.GAP)) / 2;
      row.nodes.forEach((n, c) => box.set(n.id, { x: K.PADX + off + c * (cw + K.GAP), y: 0, w: cw, h: ch, row: ri }));
    });
    // 5. Ports: each card side spreads its edge ends evenly, sorted by where the other card is.
    const sides = new Map<string, { r: Route; end: 0 | 1; ref: number }[]>();
    const add = (id: string, s: string, r: Route, end: 0 | 1, ref: number) => {
      const k = `${id}\u0000${s}`;
      (sides.get(k) ?? sides.set(k, []).get(k)!).push({ r, end, ref });
    };
    const cx = (id: string) => box.get(id)!.x + box.get(id)!.w / 2;
    for (const r of R) { add(r.e.from, r.out, r, 0, cx(r.e.to)); add(r.e.to, r.in, r, 1, cx(r.e.from)); }
    for (const [k, list] of sides) {
      const bx = box.get(k.split('\u0000')[0])!;
      list.sort((p, q) => p.ref - q.ref).forEach((p, i) => { p.r[p.end ? 'tx' : 'sx'] = bx.x + (bx.w * (i + 1)) / (list.length + 1); });
    }
    let used = 0;
    for (const r of R) {
      const A = r.a.row, B = r.b.row;
      r.gx = undefined;
      if (Math.abs(B - A) <= 1) { r.cs = [Math.min(A, B)]; continue; }
      const between = rows.slice(Math.min(A, B) + 1, Math.max(A, B));
      const blocked = between.some((row) => row.nodes.some((n) => { const q = box.get(n.id)!; return r.sx > q.x - 5 && r.sx < q.x + q.w + 5; }));
      if (!blocked) { r.cs = [r.dir > 0 ? B - 1 : B]; continue; }
      r.cs = r.dir > 0 ? [A, B - 1] : [A - 1, B];
      r.gx = W - 5 - used++ * 7;
    }
    if (used <= strips) break;
    strips = used; // reserve more strip and lay the cards out again (it only grows, so it ends)
  }
  // 6. Tracks: one per edge per gap, ordered left to right by their horizontal run.
  const corr: { r: Route; i: number; x: number }[][] = rows.map(() => []);
  for (const r of R) r.cs.forEach((c, i) => corr[c].push({ r, i, x: i === 0 ? Math.min(r.sx, r.gx ?? r.tx) : Math.min(r.gx!, r.tx) }));
  corr.forEach((list) => list.sort((p, q) => p.x - q.x).forEach((p, j) => { p.r.tr[p.i] = j; }));
  // 7. Top to bottom: lane header, card row, gap; bands wrap a lane's rows.
  let y = 0;
  const bands: LensLayout['bands'] = [];
  const ctop: number[] = [];
  rows.forEach((row, ri) => {
    if (row.first) { bands.push({ lane: row.lane, y, h: 0 }); y += K.HEAD; }
    row.y = y;
    for (const n of row.nodes) box.get(n.id)!.y = y;
    y += ch;
    const band = bands[bands.length - 1];
    if (row.last) band.h = y + 6 - band.y;
    ctop[ri] = y + (row.last ? 6 : 2);
    const next = rows[ri + 1];
    y = ctop[ri] + corr[ri].length * K.TRACK + (next ? (row.last ? 8 : 6) : 0);
  });
  const H = Math.max(y, 10);
  const ty = (c: number, j: number) => ctop[c] + K.TRACK * (j + 0.5);
  // 8. Polylines → rounded paths, arrowheads and label spots.
  const out: LayoutEdge[] = R.map((r) => {
    const sb = box.get(r.e.from)!, tb = box.get(r.e.to)!;
    const sy = r.out === 'b' ? sb.y + sb.h : sb.y, ey = r.in === 'b' ? tb.y + tb.h : tb.y;
    const y0 = ty(r.cs[0], r.tr[0]);
    const pts: [number, number][] = [[r.sx, sy], [r.sx, y0]];
    if (r.cs.length === 2) { const y1 = ty(r.cs[1], r.tr[1]); pts.push([r.gx!, y0], [r.gx!, y1], [r.tx, y1]); }
    else pts.push([r.tx, y0]);
    pts.push([r.tx, ey]);
    const dir = Math.sign(ey - pts[pts.length - 2][1]) || 1;
    const line = pts.slice();
    line[line.length - 1] = [r.tx, ey - dir * K.ARROW];
    return {
      e: r.e, pts, d: rounded(line, 6),
      head: `M${n2(r.tx)} ${n2(ey)}L${n2(r.tx - 4.5)} ${n2(ey - dir * K.ARROW)}L${n2(r.tx + 4.5)} ${n2(ey - dir * K.ARROW)}Z`,
      label: { x: (pts[1][0] + pts[2][0]) / 2, y: y0 }, corridor: r.cs[0], track: r.tr[0],
    };
  });
  const nodes: LayoutNode[] = [...at.values()].map((v) => { const b = box.get(v.n.id)!; return { ...v, x: b.x, y: b.y, w: b.w, h: b.h }; });
  return { W, H, cols, nodes, edges: out, bands, hidden: all.size - nodes.length };
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** A polyline with its corners rounded (the radius clamped to half the shorter neighbour segment). */
export function rounded(p: [number, number][], rad: number): string {
  let d = `M${n2(p[0][0])} ${n2(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], [cx, cy] = p[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const r = Math.min(rad, l1 / 2, l2 / 2);
    if (r < 0.5) { d += `L${n2(bx)} ${n2(by)}`; continue; }
    d += `L${n2(bx - ((bx - ax) / l1) * r)} ${n2(by - ((by - ay) / l1) * r)}Q${n2(bx)} ${n2(by)} ${n2(bx + ((cx - bx) / l2) * r)} ${n2(by + ((cy - by) / l2) * r)}`;
  }
  const z = p[p.length - 1];
  return d + `L${n2(z[0])} ${n2(z[1])}`;
}
