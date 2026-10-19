import type * as THREE from 'three';
import type { OporaCard, OporaRun, OporaState } from '../../../shared/protocol';
import { canvasTexture, wrap } from '../boards/meeting';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const BG = '#0f1420';
const PANEL = '#182033';
const INK = '#e8edf7';
const MUTED = '#8a96b2';
const ACCENT = '#38d9a9';
const DESIGN = '#b197fc';

/** The columns of the pipeline, left to right: what's planned and free, what the office is on, what waits on someone, what's closed. */
const COLUMNS: { key: string; title: string; cards: (s: OporaState) => (OporaCard | OporaRun)[] }[] = [
  { key: 'free', title: '📋 Ready on the canvas', cards: (s) => s.cards.filter((c) => c.status === 'frontier') },
  { key: 'office', title: '🛠️ In the office', cards: (s) => s.runs.filter((r) => r.state !== 'gone') },
  { key: 'waiting', title: '⏳ Waiting / to route', cards: (s) => s.cards.filter((c) => c.status === 'blocked' || c.status === 'waiting' || c.status === 'needsRouting') },
  { key: 'closed', title: '✅ Closed', cards: (s) => s.cards.filter((c) => c.status === 'closed') },
];

/**
 * The screen on the planning room's glass: the Opora canvas as a pipeline, the plan on the left and
 * the office's work on the right, so you see from across the room what's planned, who's on what,
 * and what's waiting.
 */
export class OporaScreenTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1840, 680);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(s: OporaState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    // Across the top: Opora, the project, and the autopilot.
    g.fillStyle = INK;
    g.font = `900 44px ${FONT}`;
    g.textAlign = 'left';
    g.fillText('🛰️ Opora', 30, 58);
    const after = 30 + g.measureText('🛰️ Opora').width + 28;
    g.font = `800 32px ${FONT}`;
    g.fillStyle = s.connected && s.project ? ACCENT : '#ff8787';
    g.fillText(s.project ? `${s.project.name} · ${s.workspace}` : s.connected ? 'not linked to this floor' : 'not running', after, 56);
    g.textAlign = 'right';
    g.fillStyle = s.autopilot ? ACCENT : MUTED;
    g.fillText(s.autopilot ? `🤖 autopilot · ${s.maxRuns} at a time` : 'autopilot off', W - 30, 56);
    g.textAlign = 'left';

    if (!s.connected || !s.project) {
      g.fillStyle = MUTED;
      g.font = `800 38px ${FONT}`;
      g.textAlign = 'center';
      const why = s.error ?? 'Opora isn’t answering';
      for (const [i, l] of wrap(g, why, W - 200).slice(0, 3).entries()) g.fillText(l, W / 2, H / 2 + i * 50);
      g.font = `700 30px ${FONT}`;
      g.fillText('Press E here to open the 🛰️ Opora window', W / 2, H - 70);
      g.textAlign = 'left';
      this.texture.needsUpdate = true;
      return;
    }

    const colW = (W - 30 * 2 - 20 * 3) / 4;
    COLUMNS.forEach((col, i) => {
      const x = 30 + i * (colW + 20);
      const top = 90;
      g.fillStyle = PANEL;
      g.fillRect(x, top, colW, H - top - 24);
      const items = col.cards(s);
      g.fillStyle = INK;
      g.font = `900 30px ${FONT}`;
      g.fillText(`${col.title} · ${items.length}`, x + 16, top + 42);
      let y = top + 64;
      for (const [n, item] of items.entries()) {
        if (y > H - 80) {
          g.fillStyle = MUTED;
          g.font = `800 24px ${FONT}`;
          g.fillText(`…and ${items.length - n} more`, x + 16, y + 30);
          break;
        }
        const run = 'cardName' in item ? item : undefined;
        const name = run ? run.cardName : (item as OporaCard).name;
        const design = item.group === 'design';
        g.fillStyle = design ? '#2b2442' : '#1f2a42';
        g.fillRect(x + 12, y, colW - 24, 64);
        g.fillStyle = design ? DESIGN : ACCENT;
        g.fillRect(x + 12, y, 6, 64);
        g.fillStyle = INK;
        g.font = `800 25px ${FONT}`;
        g.fillText(wrap(g, name, colW - 60)[0] ?? '', x + 28, y + 28);
        g.fillStyle = MUTED;
        g.font = `700 20px ${FONT}`;
        const sub = run ? `${run.workerName ?? '…'} · ${run.state === 'done' ? 'turn ended' : 'working'}` : [(item as OporaCard).sectorName, (item as OporaCard).stage ?? (item as OporaCard).profile ?? ((item as OporaCard).status === 'needsRouting' ? 'needs a pipeline' : '')].filter(Boolean).join(' · ');
        g.fillText(wrap(g, `${design ? '🎨 ' : ''}${sub}`, colW - 60)[0] ?? '', x + 28, y + 54);
        y += 74;
      }
    });
    this.texture.needsUpdate = true;
  }
}
