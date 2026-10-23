// The purple board's plan by layers: inside the orchestrator's card on Opora's canvas, its areas, the
// sectors drawn in them and their nodes, as in the design "Místnost – rozložení": a header row
// (oblast → sektory → uzly), a box per sector with its progress (hotovo / běží / plán) and its nodes,
// each with its state and the worker on it, and under the header what a person can do (E at the board).

import { cleanFocus, inFocus } from '../../../shared/opora-scope';
import type { OporaState } from '../../../shared/protocol';
import { fit } from '../oporascope/screen';
import { initial, TONE, type PlanView, type SectorView } from './model';
import { box, dot, FONT, GREEN, INK, MUTED, pill, PURPLE, title } from './paint';

const NODE_H = 34;
const MAX_NODES = 6;

/** The plan panel in the rectangle (x, y, w, h). */
export function paintLayers(g: CanvasRenderingContext2D, s: OporaState, v: PlanView, x: number, y: number, w: number, h: number) {
  if (!v.cardId) return pages(g, s, x, y, w);
  // The header row: oblast → sektory → uzly, as the design has it.
  let cx = x;
  const chip = (t: string, lv: boolean) => { cx += pill(g, t, cx, y + 16, 34, lv ? '#efe4fb' : '#ffffff', INK, lv ? PURPLE : undefined) + 8; };
  chip('stránka', true);
  g.font = `900 24px ${FONT}`;
  g.fillStyle = INK;
  g.textAlign = 'left';
  const nm = fit(g, v.name ?? '', 300);
  g.fillText(nm, cx, y + 17);
  cx += g.measureText(nm).width + 14;
  for (const [lv, n] of [['oblasti', v.counts.area], ['sektory', v.counts.sector], ['uzly', v.counts.node]] as const) {
    g.fillStyle = MUTED;
    g.font = `900 22px ${FONT}`;
    g.fillText('→', cx, y + 17);
    cx += 30;
    chip(lv, true);
    g.fillStyle = INK;
    g.font = `900 22px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(String(n), cx, y + 17);
    cx += 34;
  }
  // What a person can do here, from the board's window (E), as the design puts it under the card.
  let ax = x;
  for (const t of ['⏸ Pozastavit', '↻ Přeplánovat', '👤 Přidat stůl']) ax += pill(g, t, ax, y + 58, 32, '#ffffff', INK, INK) + 8;
  ax += pill(g, 'E', ax, y + 58, 32, INK, '#fffaf3') + 10;
  g.textAlign = 'left';
  g.fillStyle = MUTED;
  g.font = `800 17px ${FONT}`;
  g.fillText('zásahy na tabuli: stůl, přeplánování, pauza', ax, y + 59);

  const top = y + 88;
  if (v.read === 'reading') return note(g, 'Čtu z Opory, co je uvnitř stránky…', x, top + 30);
  if (v.read !== 'ok') return note(g, v.read === 'missing' ? 'Stránka teď není na canvasu Opory.' : 'Opora teď neodpovídá: zkusím to znovu.', x, top + 30);
  const sectors = v.areas.flatMap((a) => (a.sectors.length ? a.sectors.map((sec) => ({ area: a.area ? a.name : '', sec })) : [{ area: a.name, sec: undefined as SectorView | undefined }]));
  if (!sectors.length) {
    note(g, 'Uvnitř stránky zatím nic není: plánovač tu vytvoří oblasti → sektory → uzly.', x, top + 30);
    if (v.subpages.length) {
      title(g, `Podstránky · ${v.subpages.length}`, x, top + 70, 20);
      let px = x;
      for (const p of v.subpages.slice(0, 8)) { px += pill(g, p.name, px, top + 120, 38, '#ffffff', INK, INK) + 10; if (px > x + w - 160) break; }
    }
    return;
  }
  // Sector boxes in three columns, each going into the shortest one.
  const cols = Math.min(3, Math.max(1, sectors.length));
  const cw = (w - (cols - 1) * 14) / cols;
  const heights = new Array(cols).fill(top);
  for (const { area, sec } of sectors) {
    const n = sec ? Math.min(MAX_NODES, sec.nodes.length) + (sec.nodes.length > MAX_NODES ? 1 : 0) : 0;
    const bh = 78 + (area ? 22 : 0) + n * NODE_H;
    const col = heights.indexOf(Math.min(...heights));
    const bx = x + col * (cw + 14), by = heights[col];
    if (by + Math.min(bh, 120) > y + h) continue;
    sector(g, area, sec, bx, by, cw, Math.min(bh, y + h - by));
    heights[col] = by + bh + 12;
  }
}

function sector(g: CanvasRenderingContext2D, area: string, sec: SectorView | undefined, x: number, y: number, w: number, h: number) {
  const hot = !!sec?.working;
  box(g, x, y, w, h, 14, hot ? '#f6f0ff' : '#ffffff', hot ? PURPLE : INK, hot ? 4 : 3);
  g.save();
  g.beginPath();
  g.roundRect(x, y, w, h, 14);
  g.clip();
  let ty = y + 22;
  g.textAlign = 'left';
  if (area) {
    g.fillStyle = MUTED;
    g.font = `900 15px ${FONT}`;
    g.fillText(fit(g, `OBLAST · ${area}`, w - 24), x + 12, ty);
    ty += 22;
  }
  g.fillStyle = INK;
  g.font = `900 22px ${FONT}`;
  g.fillText(fit(g, sec ? `${hot ? '🎯 ' : ''}${sec.name}` : 'prázdná oblast', w - 90), x + 12, ty);
  if (!sec) { g.restore(); return; }
  const total = sec.nodes.length || 1;
  const pct = Math.round((sec.done / total) * 100);
  g.textAlign = 'right';
  g.fillStyle = MUTED;
  g.font = `800 17px ${FONT}`;
  g.fillText(`${pct} %`, x + w - 12, ty);
  // hotovo · běží · plán
  const bx = x + 12, bw = w - 24, by = ty + 16;
  box(g, bx, by, bw, 10, 5, '#efe4fb');
  const dw = (bw * sec.done) / total, ww = (bw * sec.working) / total;
  if (dw) box(g, bx, by, dw, 10, 5, GREEN);
  if (ww) box(g, bx + dw, by, ww, 10, 5, '#5bc0eb');
  let ny = by + 22;
  for (const n of sec.nodes.slice(0, MAX_NODES)) {
    const [color, words] = TONE[n.tone];
    dot(g, x + 22, ny + 14, 7, color);
    g.textAlign = 'left';
    g.fillStyle = INK;
    g.font = `800 17px ${FONT}`;
    g.fillText(fit(g, n.node.name, w - 190), x + 36, ny + 10);
    g.fillStyle = MUTED;
    g.font = `700 14px ${FONT}`;
    g.fillText(fit(g, [words, n.node.card?.layer, n.node.checks ? `${n.node.checks} kontrol` : ''].filter(Boolean).join(' · '), w - 190), x + 36, ny + 27);
    // The worker on it, or a dashed "?" while nobody is.
    const ax = x + w - 26, ay = ny + 16;
    g.setLineDash(n.worker ? [] : [4, 3]);
    dot(g, ax, ay, 12, n.worker ? '#ffd166' : '#ffffff');
    g.setLineDash([]);
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.font = `900 14px ${FONT}`;
    g.fillText(n.worker ? initial(n.worker) : '?', ax, ay + 1);
    ny += NODE_H;
  }
  if (sec.nodes.length > MAX_NODES) {
    g.textAlign = 'left';
    g.fillStyle = MUTED;
    g.font = `800 15px ${FONT}`;
    g.fillText(`+ ${sec.nodes.length - MAX_NODES} dalších`, x + 36, ny + 12);
  }
  g.restore();
}

function note(g: CanvasRenderingContext2D, text: string, x: number, y: number) {
  g.textAlign = 'left';
  g.fillStyle = MUTED;
  g.font = `800 24px ${FONT}`;
  g.fillText(text, x, y);
}

/** No card yet: how to get one, and the pages the cell's focus has. */
function pages(g: CanvasRenderingContext2D, s: OporaState, x: number, y: number, w: number) {
  note(g, 'Zapni stránku nebo podstránku na 🎚️ Zaměření buňky (severní sklo):', x, y + 14);
  note(g, 'přiletí sem jako karta pro orchestrátora a tady se rozplánuje po vrstvách.', x, y + 48);
  const focus = cleanFocus(s.scope, s.focus);
  const mine = s.scope.filter((n) => n.level === 'page' && inFocus(s.scope, focus, n.id));
  title(g, `Stránky v zaměření · ${mine.length}`, x, y + 92, 20);
  let px = x, py = y + 150;
  for (const p of mine.slice(0, 24)) {
    g.font = `900 19px ${FONT}`;
    if (px + g.measureText(p.name).width + 40 > x + w) { px = x; py += 52; }
    px += pill(g, p.name, px, py, 40, '#ffffff', INK, INK) + 10;
  }
}
