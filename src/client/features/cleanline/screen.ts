import * as THREE from 'three';
import type { LineView } from './controller';
import { laneColor, paintGraph } from './paint';

const W = 1400;
const H = 788;

/** The wall's face: title, a mini graph of main and its live branches, and the four counters. */
export class LineScreen {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(view: LineView) {
    const g = this.canvas.getContext('2d')!;
    const d = view.data;
    g.fillStyle = '#142337';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#06d6a0';
    g.fillRect(0, 0, 12, H);
    const text = (s: string, x: number, y: number, size: number, color: string, max = 1270, weight = 700) => {
      g.fillStyle = color;
      g.font = `${weight} ${size}px system-ui, sans-serif`;
      let fit = s;
      while (fit.length && g.measureText(fit).width > max) fit = fit.slice(0, -1);
      g.fillText(fit === s ? fit : `${fit.slice(0, -1)}…`, x, y);
    };
    text('ČISTÁ LINIE', 54, 84, 56, '#06d6a0');
    text(d ? `${d.repo.label} · ${d.repo.remote} ${d.repo.mainSha?.slice(0, 7) ?? '?'}` : view.loading ? 'Načítám…' : view.error ?? '—', 54, 132, 28, '#acbed3', 820, 600);

    // Counters, right: what's next, what's red, what's to tidy, and the deploy drift.
    const c = d?.counts;
    const tiles: [string, string, string][] = [
      ['NA ŘADĚ', c ? (c.next ? `#${c.next}` : '—') : '…', c?.next ? '#06d6a0' : '#acbed3'],
      ['ČERVENÉ', c ? String(c.red) : '…', c?.red ? '#ef476f' : '#06d6a0'],
      ['K ÚKLIDU', c ? String(c.cleanup) : '…', c?.cleanup ? '#f6bd60' : '#06d6a0'],
      ['DRIFT', c ? String(c.drift) : '…', c?.drift ? '#ef476f' : '#06d6a0'],
    ];
    tiles.forEach(([label, value, color], i) => {
      const x = 900 + (i % 2) * 240;
      const y = 180 + Math.floor(i / 2) * 230;
      g.fillStyle = '#1d3150';
      g.beginPath();
      g.roundRect(x, y, 220, 200, 22);
      g.fill();
      text(label, x + 22, y + 48, 26, '#acbed3', 190);
      text(value, x + 22, y + 150, 86, color, 190, 800);
    });

    // The mini graph: the newest rows, lanes on the left, subjects beside.
    const rows = (d?.graph ?? []).slice(0, 13);
    const top = 190;
    const rowH = 38;
    const lanes = Math.min(Math.max(1, ...rows.map((r) => r.lane + 1)), 6);
    const geo = { x: (l: number) => 70 + Math.min(l, 6) * 30, y: (i: number) => top + i * rowH, rowH, dot: 9 };
    g.save();
    g.beginPath();
    g.rect(40, top - rowH / 2, 820, rows.length * rowH);
    g.clip();
    paintGraph(g, rows, geo, 4);
    g.restore();
    rows.forEach((r, i) => {
      const label = r.pr ? `#${r.pr} ` : '';
      text(`${label}${r.subject.replace(/\s*\(#\d+\)\s*$/, '')}`, 70 + lanes * 30 + 16, geo.y(i) + 10, 26, r.main ? '#edf4fc' : laneColor(r.lane), 760 - lanes * 30, r.main ? 600 : 700);
    });
    if (!rows.length) text(view.error ?? d?.error ?? (view.loading ? 'Načítám graf…' : 'Žádné commity'), 70, top + 20, 30, '#acbed3', 780);
    text(d?.queue.length ? `Fronta: ${d.queue.length} PR · zelených ${d.queue.filter((q) => q.green).length}` : d?.queueNote ?? 'Fronta je prázdná', 54, 716, 28, '#acbed3', 820, 600);
    text('E  Graf · Fronta · Zdraví · Pravidla', 900, 716, 30, '#f6bd60', 460);
    this.texture.needsUpdate = true;
  }
}
