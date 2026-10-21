import * as THREE from 'three';
import { connectionLabel, PHASES, visibleRows, type WallSnapshot, type WallView } from './model';

export class ProcessTexture {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  constructor() {
    this.canvas.width = 1920; this.canvas.height = 320;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }
  draw(s: WallSnapshot, view: WallView, page: number, t: number, reduced: boolean) {
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#091523'; g.fillRect(0, 0, 1920, 320);
    const text = (v: string, x: number, y: number, size = 24, color = '#d9e9f8', width?: number) => {
      g.fillStyle = color; g.font = `600 ${size}px system-ui, sans-serif`;
      let shown = v;
      if (width) while (shown.length > 1 && g.measureText(shown).width > width) shown = shown.slice(0, -2) + '…';
      g.fillText(shown, x, y);
    };
    text('OPORA / ' + (view === 'workers' ? 'PRACOVNÍCI' : view === 'blockers' ? 'BLOKACE' : 'CELÝ PROCES'), 28, 42, 29);
    text(connectionLabel(s), 1330, 40, 23, s.connected && s.ready ? '#6ce9cf' : '#ffcb82');
    text(`${s.workers} agentů    /    ${s.running} pracuje    /    ${s.queued} ve frontě    /    ${s.blocked} blokací`, 28, 84, 25, '#9bb6d1');
    text(s.floor, 1330, 82, 23, '#9bb6d1', 560);
    const rows = visibleRows(s, view), count = Math.max(1, Math.ceil(rows.length / 3));
    const part = rows.slice((page % count) * 3, (page % count) * 3 + 3);
    PHASES.forEach((name, i) => text(name, 825 + i * 172, 118, 19, '#8ba5c0'));
    if (!part.length) text(view === 'blockers' ? 'Žádná doložená blokace v aktuálních datech.' : 'Zatím žádná práce. Stěna čeká na skutečné události kanceláře.', 32, 190, 30);
    part.forEach((row, n) => {
      const y = 150 + n * 52;
      text(row.title, 28, y, 23, row.blocked ? '#ffcb82' : '#e6f2ff', 470);
      text(row.owner + ' · ' + row.detail, 28, y + 22, 16, '#9bb6d1', 735);
      g.strokeStyle = '#2b4157'; g.lineWidth = 3; g.beginPath(); g.moveTo(850, y); g.lineTo(1710, y); g.stroke();
      PHASES.forEach((_, i) => {
        g.fillStyle = i === row.phase ? row.blocked ? '#ffcb82' : '#6ce9cf' : '#304357';
        g.beginPath(); g.arc(850 + i * 172, y, i === row.phase ? 10 : 5, 0, Math.PI * 2); g.fill();
      });
      // One small spider at the observed stage. Legs move only while a connected worker reports work.
      const x = 850 + row.phase * 172, walk = row.moving && s.connected && s.ready && !reduced ? Math.sin(t * 7) * 4 : 0;
      g.strokeStyle = row.blocked ? '#ffcb82' : '#6ce9cf'; g.lineWidth = 2;
      for (const side of [-1, 1]) for (let leg = 0; leg < 4; leg++) {
        g.beginPath(); g.moveTo(x + side * 5, y + (leg - 1.5) * 3); g.lineTo(x + side * 14, y + (leg - 1.5) * 7 + walk); g.lineTo(x + side * 20, y + (leg - 1.5) * 10); g.stroke();
      }
    });
    text(`E / klik → otevřít   ·   Strana ${(page % count) + 1}/${count}   ·   Přepnutí pohledu v detailu`, 28, 300, 20, '#74d9d5');
    text('Paměť / nasazení: bez adaptéru', 1440, 300, 20, '#b5a5d9');
    this.texture.needsUpdate = true;
  }
}
