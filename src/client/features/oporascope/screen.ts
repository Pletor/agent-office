import type * as THREE from 'three';
import { childrenOf, cleanFocus, focusLine, focusPaths, inFocus, SCOPE_LEVEL_NAME } from '../../../shared/opora-scope';
import type { OporaScopeNode, OporaState } from '../../../shared/protocol';
import { canvasTexture } from '../boards/meeting';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
const ON = '#38d9a9';
const OFF = '#ced4da';
const ROWS = 8;

/**
 * The columns the cascade shows: the top level, then the children of the node switched on in the
 * column before (the first focus's way down), as far as there are any.
 */
export function scopeColumns(scope: readonly OporaScopeNode[], focus: readonly string[], open: readonly string[] = focusPaths(scope, focus)[0]?.map((n) => n.id) ?? []): { parent: string | null; nodes: OporaScopeNode[] }[] {
  const cols: { parent: string | null; nodes: OporaScopeNode[] }[] = [{ parent: null, nodes: childrenOf(scope, null) }];
  for (const id of open) {
    const nodes = childrenOf(scope, id);
    if (!nodes.length) break;
    cols.push({ parent: id, nodes });
  }
  return cols;
}

/** The 🎚️ switchboard on the inside of the north glass: the cascade, each node on or off, and the focus in words. */
export class ScopeBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1680, 600);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(s: OporaState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#f8f9fb';
    g.fillRect(0, 0, W, H);
    g.fillStyle = INK;
    g.fillRect(0, 0, W, 64);
    g.fillStyle = '#fffaf3';
    g.font = `900 34px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText('🎚️ Zaměření buňky', 22, 33);
    g.textAlign = 'right';
    g.font = `800 26px ${FONT}`;
    g.fillText(s.project ? `${s.project.name}${s.workspace ? ` · ${s.workspace === 'main' ? 'main' : (s.workspaces.find((w) => w.id === s.workspace)?.label.split(' · ')[0] ?? s.workspace)}` : ''}` : 'Opora není propojená', W - 22, 33);
    if (!s.scope.length) {
      g.fillStyle = INK;
      g.textAlign = 'center';
      g.font = `800 34px ${FONT}`;
      g.fillText(!s.connected ? 'Opora neběží' : !s.project ? 'Propoj patro s projektem v okně 🛰️ Opora' : 'Načítám architekturu projektu…', W / 2, H / 2);
      this.texture.needsUpdate = true;
      return;
    }
    const focus = cleanFocus(s.scope, s.focus);
    const on = new Set(focus);
    const cols = scopeColumns(s.scope, focus);
    const colW = (W - 40) / Math.max(4, cols.length);
    cols.forEach((col, i) => {
      const x = 20 + i * colW;
      g.textAlign = 'left';
      g.fillStyle = '#868e96';
      g.font = `900 22px ${FONT}`;
      g.fillText(SCOPE_LEVEL_NAME[col.nodes[0].level].toUpperCase(), x + 8, 92);
      col.nodes.slice(0, ROWS).forEach((n, r) => {
        const y = 112 + r * 52;
        const lit = on.has(n.id);
        g.fillStyle = lit ? '#e6fcf5' : '#ffffff';
        g.strokeStyle = lit ? ON : '#dee2e6';
        g.lineWidth = 3;
        g.beginPath();
        g.roundRect(x, y, colW - 16, 44, 10);
        g.fill();
        g.stroke();
        // The switch: a pill with its knob right when on.
        g.fillStyle = lit ? ON : OFF;
        g.beginPath();
        g.roundRect(x + 10, y + 11, 44, 22, 11);
        g.fill();
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(lit ? x + 43 : x + 21, y + 22, 8, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = lit ? INK : '#868e96';
        g.font = `${lit ? 900 : 700} 22px ${FONT}`;
        const label = n.host ? `${n.name} · ${n.host}` : n.name;
        g.fillText(fit(g, label, colW - 90), x + 64, y + 23);
      });
      if (col.nodes.length > ROWS) {
        g.fillStyle = '#868e96';
        g.font = `800 20px ${FONT}`;
        g.fillText(`+ ${col.nodes.length - ROWS} dalších`, x + 10, 112 + ROWS * 52 + 4);
      }
      if (i < cols.length - 1) {
        g.fillStyle = ON;
        g.font = `900 30px ${FONT}`;
        g.fillText('›', x + colW - 14, 92);
      }
    });
    // Along the bottom: the focus in words, and the cards in it.
    const line = focusLine(s.scope, focus);
    const cards = s.cards.filter((c) => inFocus(s.scope, focus, c.id));
    g.fillStyle = INK;
    g.fillRect(0, H - 58, W, 58);
    g.fillStyle = line ? ON : '#fffaf3';
    g.font = `900 24px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(fit(g, line ? `Pracuje se na: ${line}` : 'Pracuje se na celém projektu', W - 420), 20, H - 29);
    g.textAlign = 'right';
    g.fillStyle = '#fffaf3';
    g.font = `800 22px ${FONT}`;
    g.fillText(`${cards.filter((c) => c.status === 'frontier').length} volných · ${cards.filter((c) => c.status === 'claimed').length} v práci`, W - 20, H - 29);
    this.texture.needsUpdate = true;
  }
}

/** `text`, cut with an ellipsis to fit `maxW`. */
export function fit(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
