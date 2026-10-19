import * as THREE from 'three';
import type { AttentionView } from './controller';

export class AttentionScreen {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;

  constructor() {
    this.canvas.width = 1400;
    this.canvas.height = 680;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(view: AttentionView, workerNames: string[]) {
    const g = this.canvas.getContext('2d')!;
    const d = view.data;
    const count = (d?.items.length ?? 0) + workerNames.length;
    g.fillStyle = '#142337'; g.fillRect(0, 0, 1400, 680);
    g.fillStyle = '#f6bd60'; g.fillRect(0, 0, 12, 680);
    const line = (text: string, y: number, size = 36, color = '#edf4fc') => {
      g.fillStyle = color;
      g.font = `700 ${size}px system-ui, sans-serif`;
      let fit = text;
      while (fit.length && g.measureText(fit).width > 1270) fit = fit.slice(0, -1);
      g.fillText(fit === text ? fit : `${fit.slice(0, -1)}…`, 54, y);
    };
    line('BOSS OFFICE  /  PRO TEBE', 82, 48, '#f6bd60');
    line(d?.project?.name ?? 'Rozhodnutí a odpovědi', 137, 30, '#acbed3');
    line(count ? `${count} × potřebujeme tvůj zásah` : view.loading ? 'Načítám požadavky…' : view.error || d?.error ? 'Stav není úplně ověřen' : 'Teď není vyžadován tvůj zásah', 218, 44);
    const titles = [...workerNames.map((n) => `${n} — čeká na odpověď`), ...(d?.items.map((i) => i.title) ?? [])];
    titles.slice(0, 3).forEach((title, i) => line(`• ${title}`, 300 + i * 68, 32));
    if (!titles.length) line(view.error || d?.error || 'Žádné ruční hledání karet v projektu.', 316, 30, '#acbed3');
    line(`Systém / agenti: ${d?.system.length ?? '—'}   ·   celý propojený pracovní prostor`, 558, 26, '#acbed3');
    line('E  Otevřít tabuli a přejít přímo k problému', 626, 33, '#f6bd60');
    this.texture.needsUpdate = true;
  }
}
