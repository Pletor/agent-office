import type * as THREE from 'three';
import type { OporaState, StatusLight, StatusPanel, StatusState } from '../../../shared/protocol';
import { canvasTexture, wrap } from '../boards/meeting';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const BG = '#0f1420';
const PANEL = '#182033';
const INK = '#e8edf7';
const MUTED = '#8a96b2';

/** Each light's lamp, lit and dimmed. */
export const LAMP: Record<Exclude<StatusLight, 'unknown'>, { on: string; off: string }> = {
  red: { on: '#ff4d4f', off: '#3a1f24' },
  amber: { on: '#ffb020', off: '#3a3020' },
  green: { on: '#2fd67b', off: '#1d3428' },
};
const DOT: Record<string, string> = { bad: LAMP.red.on, warn: LAMP.amber.on, ok: LAMP.green.on };

/** The floor's link to Opora in a line: its project and workspace, and its cards free and held. */
export function oporaLine(o: Pick<OporaState, 'connected' | 'project' | 'workspace' | 'cards' | 'runs'>): string {
  if (!o.connected) return 'Most k Opoře: nepřipojeno';
  if (!o.project) return 'Patro není propojené s projektem Opory';
  const free = o.cards.filter((c) => c.status === 'frontier').length;
  const held = o.runs.filter((r) => r.state !== 'gone').length;
  return `${o.project.name}${o.workspace ? ` · ${o.workspace}` : ''} · volné ${free} · v práci ${held}`;
}

/**
 * The status wall's picture: Kancelář on the left and Opora on the right, each with a traffic
 * light, its word, and its first few reasons, worst first.
 */
export class StatusScreenTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1200, 700);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(s: StatusState | null, opora: Parameters<typeof oporaLine>[0]) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = INK;
    g.font = `900 46px ${FONT}`;
    g.fillText('🚦 Stav', 28, 60);
    g.textAlign = 'right';
    g.fillStyle = MUTED;
    g.font = `800 26px ${FONT}`;
    const at = s?.office.checkedAt ?? s?.opora.checkedAt;
    g.fillText(s?.checking ? 'kontroluji…' : at ? `zkontrolováno ${new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}` : 'čekám na první kontrolu', W - 28, 58);
    g.textAlign = 'left';
    const colW = (W - 28 * 2 - 24) / 2;
    const panels: [StatusPanel | undefined, string | undefined][] = [
      [s?.office, undefined],
      [s?.opora, oporaLine(opora)],
    ];
    panels.forEach(([p, extra], i) => this.panel(p, i === 0 ? 'Kancelář' : 'Opora', 28 + i * (colW + 24), 88, colW, H - 88 - 70, extra));
    g.fillStyle = MUTED;
    g.font = `800 26px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('E: podrobnosti a odkazy', W / 2, H - 26);
    g.textAlign = 'left';
    this.texture.needsUpdate = true;
  }

  private panel(p: StatusPanel | undefined, title: string, x: number, y: number, w: number, h: number, extra?: string) {
    const { g } = this;
    const light = p?.light ?? 'unknown';
    g.fillStyle = PANEL;
    g.beginPath();
    g.roundRect(x, y, w, h, 18);
    g.fill();
    // The traffic light: a housing with its three lamps, the one that's on glowing.
    const hx = x + 22;
    const hy = y + 22;
    const r = 34;
    g.fillStyle = '#05070c';
    g.beginPath();
    g.roundRect(hx, hy, r * 2 + 24, r * 6 + 48, 22);
    g.fill();
    (['red', 'amber', 'green'] as const).forEach((c, i) => {
      const cx = hx + 12 + r;
      const cy = hy + 12 + r + i * (r * 2 + 12);
      const on = light === c;
      g.save();
      if (on) {
        g.shadowColor = LAMP[c].on;
        g.shadowBlur = 36;
      }
      g.fillStyle = on ? LAMP[c].on : LAMP[c].off;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.restore();
    });
    // Its name and word, then the reasons.
    const tx = hx + r * 2 + 24 + 22;
    const tw = x + w - tx - 18;
    g.fillStyle = INK;
    g.font = `900 40px ${FONT}`;
    g.fillText(title, tx, y + 62);
    g.fillStyle = light === 'unknown' ? MUTED : LAMP[light].on;
    g.font = `900 34px ${FONT}`;
    g.fillText(p?.summary ?? 'Zjišťuji…', tx, y + 104);
    let ly = y + 146;
    if (extra) {
      g.fillStyle = MUTED;
      g.font = `800 21px ${FONT}`;
      g.fillText(wrap(g, extra, tw)[0] ?? '', tx, ly);
      ly += 34;
    }
    const reasons = p?.reasons ?? [];
    const bottom = y + h - 14;
    let shown = 0;
    g.font = `800 23px ${FONT}`;
    for (const [i, reason] of reasons.entries()) {
      // Below the light, the reasons take the panel's whole width.
      const left = ly - 20 > hy + r * 6 + 48 ? x + 22 : tx;
      const width = x + w - left - 18;
      // A path by its last folder; a commit is in the text already.
      const what = reason.where && !/^[0-9a-f]{40}$/.test(reason.where) ? `${reason.text} · ${reason.where.split(/[\\/]/).pop()}` : reason.text;
      const lines = wrap(g, what, width - 30).slice(0, 2);
      // Room left for this one, and for the "and more" line after it unless it's the last.
      if (ly + 26 * (lines.length - 1) + (i < reasons.length - 1 ? 36 : 0) > bottom) break;
      g.fillStyle = DOT[reason.level];
      g.beginPath();
      g.arc(left + 9, ly - 8, 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK;
      lines.forEach((l, n) => g.fillText(l, left + 28, ly + n * 26));
      ly += 26 * lines.length + 14;
      shown++;
    }
    if (shown < reasons.length) {
      g.fillStyle = MUTED;
      g.font = `800 22px ${FONT}`;
      g.fillText(`…a ${reasons.length - shown} další (E)`, x + 22, Math.min(ly, bottom));
    }
  }
}
