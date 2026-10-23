// The third screen's face in 3D (south glass of the planning room): the live overview from the design's
// left wall, painted on a canvas: the goal and its three-level bar, the counts by state, the sessions
// (the orchestrator's card first, lit purple) with their sub-sessions, the four attention boxes as
// counts, and the Novinky line. E opens the whole screen (screen.ts).

import type * as THREE from 'three';
import type { Attention } from '../../../shared/sessions-attention';
import type { Board, BoardRow } from '../../../shared/sessions-board';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
const PAPER = '#fffaf3';
const MUTED = '#6f655c';
const PURPLE = '#9b5de5';
export const STATE_COLOR: Record<BoardRow['st'], string> = {
  run: '#5bc0eb', human: '#ffd166', block: '#ef476f', done: '#06d6a0', sleep: '#b9afa3', idle: '#e9e3da', start: '#cdb8f2', gone: '#ffffff',
};
const W = 1760;
const H = 640;

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke = INK, lw = 3, dash: number[] = []) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
  if (lw) { g.setLineDash(dash); g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); g.setLineDash([]); }
}

function chip(g: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg = INK, size = 20): number {
  g.font = `900 ${size}px ${FONT}`;
  const w = g.measureText(text).width + size * 0.9;
  rr(g, x, y, w, size * 1.5, size * 0.75, bg, INK, 2.5);
  g.fillStyle = fg;
  g.textAlign = 'left';
  g.fillText(text, x + size * 0.45, y + size * 0.78);
  return w;
}

function rowNote(r: BoardRow): string {
  if (r.stale && r.st !== 'gone') return `⚠ ${r.ago} min`;
  if (r.st === 'human') return `čeká ${r.ago} min`;
  if (r.st === 'block') return 'blokováno';
  if (r.st === 'gone') return 'relace odešla';
  return r.plan[1] ? `plán ${r.plan[0]}/${r.plan[1]}` : r.st === 'done' ? 'hotovo' : 'bez plánu';
}

export class SessionsFaceTexture {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(W, H);
    this.g = c.g;
    this.texture = c.texture;
  }

  render(b: Board, att: Attention, linked: boolean) {
    const { g } = this;
    g.textBaseline = 'middle';
    g.fillStyle = INK;
    g.fillRect(0, 0, W, H);
    rr(g, 10, 10, W - 20, H - 20, 22, PAPER, PAPER, 0);
    // Header.
    g.fillStyle = INK;
    g.textAlign = 'left';
    g.font = `900 38px ${FONT}`;
    g.fillText('🧭 Relace k cíli', 34, 52);
    g.font = `800 24px ${FONT}`;
    g.fillStyle = MUTED;
    g.fillText(`${b.rows.length} relací · ${b.kids} pod-relací`, 330, 54);
    g.textAlign = 'right';
    g.fillStyle = INK;
    g.font = `900 22px ${FONT}`;
    g.fillText(`živě · ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`, W - 34, 52);
    g.beginPath(); g.arc(W - 34 - g.measureText(`živě · 00:00`).width - 18, 52, 9, 0, Math.PI * 2); g.fillStyle = '#ef476f'; g.fill();

    // Left column: the goal, counts, attention and news.
    const LX = 30, LW = 560;
    rr(g, LX, 88, LW, 212, 16, '#ffffff');
    g.textAlign = 'left';
    g.fillStyle = MUTED;
    g.font = `900 17px ${FONT}`;
    g.fillText('SPOLEČNÝ CÍL', LX + 16, 112);
    g.fillStyle = INK;
    g.font = `900 22px ${FONT}`;
    g.fillText(fit(g, b.goal.name, LW - 32), LX + 16, 142);
    const [p, c, h] = b.goal.lv;
    const bx = LX + 16, by = 162, bw = LW - 32, bh = 22;
    rr(g, bx, by, bw, bh, 8, '#ffffff', INK, 2.5);
    g.save(); g.beginPath(); g.roundRect(bx, by, bw, bh, 8); g.clip();
    g.fillStyle = '#ffd166'; g.fillRect(bx, by, (bw * p) / 100, bh);
    g.fillStyle = '#06d6a0'; g.fillRect(bx, by, (bw * c) / 100, bh);
    g.fillStyle = '#0a8a67'; g.fillRect(bx, by, (bw * h) / 100, bh);
    g.restore();
    g.font = `800 16px ${FONT}`;
    g.fillStyle = MUTED;
    g.fillText(`plán ${p} % · kód ${c} % · potvrzeno ${h} %`, bx, by + 40);
    const n = b.counts;
    let x = LX + 16;
    const y = 232;
    for (const [t, bg, fg] of [[`${n.run} běží`, '#5bc0eb', INK], [`${n.human} čeká`, '#ffd166', INK], [`${n.block} blok`, '#ef476f', '#fff'], [`${n.done} hotovo`, '#06d6a0', INK], [`${n.stale} bez pohybu`, '#ffb48f', INK]] as const) {
      x += chip(g, t, x, y, bg, fg, 19) + 8;
    }
    const boxes: [string, string][] = [[`⚠ ${att.dead.length} slepé uličky`, '#ffd9c4'], [`👻 ${att.orph.length} sirotci`, '#efe4fb'], [`🙋 ${att.hum.length} čekají`, '#fff2c7'], [`💡 ${att.fol.length} navazujících`, '#d9f7ec']];
    boxes.forEach(([t, bg], i) => {
      const bx2 = LX + (i % 2) * (LW / 2 + 4), by2 = 318 + Math.floor(i / 2) * 64;
      rr(g, bx2, by2, LW / 2 - 4, 54, 12, bg, INK, 2.5);
      g.fillStyle = INK;
      g.font = `900 24px ${FONT}`;
      g.textAlign = 'left';
      g.fillText(t, bx2 + 14, by2 + 28);
    });
    g.font = `800 17px ${FONT}`;
    g.fillStyle = MUTED;
    g.fillText(fit(g, '📰 Novinky: vnořené relace hlásí nahoru · /btw · kdo tě potřebuje…', LW), LX, 466);
    g.fillStyle = INK;
    g.font = `900 22px ${FONT}`;
    g.fillText(linked ? 'E · otevřít celou obrazovku' : 'E · otevřít (patro bez Opory)', LX, 600);

    // Right column: the sessions, the orchestrator's card first, with their sub-sessions.
    const RX = 620, RW = W - RX - 30;
    const focus = new Set(b.groups.filter((gr) => gr.focus).map((gr) => gr.id));
    const rows = [...b.rows].sort((a, z) => Number(focus.has(z.group)) - Number(focus.has(a.group)) || Number(z.stale) - Number(a.stale));
    let ry = 92;
    const RH = 44;
    if (!rows.length) {
      g.fillStyle = MUTED;
      g.font = `800 28px ${FONT}`;
      g.fillText('Žádné relace na patře – stoly jsou prázdné.', RX, 140);
    }
    for (const r of rows) {
      if (ry + RH > H - 24) break;
      const hl = focus.has(r.group);
      const dx = hl ? 8 : 0;
      rr(g, RX + dx, ry, RW - dx, RH - 6, 10, hl ? '#efe4fb' : r.stale ? '#fff1e9' : '#ffffff', hl ? PURPLE : r.stale ? '#ff8a5b' : '#e2d9cc', hl ? 3 : 2.5, r.stale ? [8, 5] : []);
      g.beginPath(); g.arc(RX + dx + 22, ry + RH / 2 - 3, 10, 0, Math.PI * 2); g.fillStyle = STATE_COLOR[r.st]; g.fill(); g.lineWidth = 3; g.strokeStyle = INK; g.stroke();
      g.textAlign = 'right';
      g.font = `800 19px ${FONT}`;
      g.fillStyle = r.stale ? '#c2512a' : MUTED;
      const note = rowNote(r);
      g.fillText(note, RX + RW - 14, ry + RH / 2 - 3);
      const nw = g.measureText(note).width;
      g.textAlign = 'left';
      g.fillStyle = INK;
      g.font = `900 22px ${FONT}`;
      g.fillText(fit(g, `${r.name} · ${r.task}`, RW - dx - 70 - nw), RX + dx + 42, ry + RH / 2 - 3);
      ry += RH;
      for (const k of r.kids.slice(-2)) {
        if (ry + RH - 8 > H - 24) break;
        rr(g, RX + dx + 28, ry, RW - dx - 28, RH - 12, 9, PAPER, '#e2d9cc', 2);
        g.beginPath(); g.arc(RX + dx + 46, ry + (RH - 12) / 2, 8, 0, Math.PI * 2); g.fillStyle = k.state === 'done' ? '#06d6a0' : k.state === 'fail' ? '#ef476f' : '#5bc0eb'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = INK; g.stroke();
        g.font = `800 18px ${FONT}`;
        g.textAlign = 'right';
        g.fillStyle = MUTED;
        const kn = k.state === 'done' ? '↑ nahlásila' : k.state === 'fail' ? 'selhala' : 'běží';
        g.fillText(kn, RX + RW - 14, ry + (RH - 12) / 2);
        g.textAlign = 'left';
        g.fillStyle = INK;
        g.fillText(fit(g, `↳ ${k.kind === 'btw' ? '/btw ' : ''}${k.name}`, RW - dx - 140), RX + dx + 62, ry + (RH - 12) / 2);
        ry += RH - 8;
      }
    }
    this.texture.needsUpdate = true;
  }
}
