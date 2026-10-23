// What the purple board's ledge shows: the orchestrator's card (the deepest page switched on at the
// 🎚️ switchboard), its area and where it is, or how to get one. Painted on a canvas, like the boards.

import type * as THREE from 'three';
import type { OporaCard, OporaState, OrchestratorState } from '../../../shared/protocol';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';
import { STATUS_CZ } from '../opora-plan/cards';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
const PAPER = '#fffaf3';
const PURPLE = '#9b5de5';

export interface Shown {
  state: OrchestratorState;
  opora: OporaState;
}

/** The focused card as the canvas has it now, and a line saying where it is. */
export function focusedCard(s: Shown): { card?: OporaCard; name: string; where: string } | undefined {
  const f = s.state.focus;
  if (!f) return undefined;
  const card = s.opora.cards.find((c) => c.id === f.cardId);
  const page = s.opora.scope.find((n) => n.id === f.cardId);
  const where = card
    ? [card.sectorName || 'bez oblasti', STATUS_CZ[card.status] ?? card.status, card.stage ? `etapa ${card.stage}` : card.profile ? `profil ${card.profile}` : 'bez pipeline'].join(' · ')
    : page ? `${page.level === 'subpage' ? 'podstránka' : 'stránka'} · zatím bez karty na řadě` : 'karta teď není na canvasu';
  return { card, name: card?.name ?? page?.name ?? f.name, where };
}

function pill(g: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, bg: string, fg: string): number {
  g.font = `900 ${Math.round(h * 0.55)}px ${FONT}`;
  const w = g.measureText(text).width + h * 0.8;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(x - w, y - h / 2, w, h, h / 2);
  g.fill();
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.fillText(text, x - w / 2, y + 1);
  return w;
}

/** The purple board's ledge: the card, and that E opens both designs of it. `flash` (0–1) lights it up as the card lands. */
export class DetailLedgeTexture {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private W = 1500;
  private H = 180;

  constructor() {
    const c = canvasTexture(this.W, this.H);
    this.g = c.g;
    this.texture = c.texture;
  }

  render(s: Shown, flash = 0) {
    const { g, W, H } = this;
    g.fillStyle = PURPLE;
    g.fillRect(0, 0, W, H);
    g.fillStyle = flash > 0 ? `rgb(255, ${Math.round(250 - 40 * flash)}, ${Math.round(243 - 130 * flash)})` : PAPER;
    g.fillRect(10, 10, W - 20, H - 20);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = PURPLE;
    g.font = `900 34px ${FONT}`;
    g.fillText('🎯 KARTA PRO ORCHESTRÁTORA · Lens + Design karta', 34, 50);
    const shown = focusedCard(s);
    g.fillStyle = INK;
    if (!shown) {
      g.font = `800 40px ${FONT}`;
      g.fillText(!s.opora.project ? 'Patro není propojené s Oporou' : 'Zapni stránku na 🎚️ Zaměření buňky (sever)', 34, 120);
    } else {
      g.font = `900 50px ${FONT}`;
      g.fillText(fit(g, shown.name, W - 420), 34, 118);
      g.textAlign = 'right';
      g.font = `800 28px ${FONT}`;
      g.fillStyle = '#5c5470';
      g.fillText(fit(g, s.state.brief ? 'orchestrátor ji vidí' : 'čtu z Opory…', 380), W - 34, 50);
    }
    pill(g, 'E · otevřít', W - 30, 118, 54, INK, PAPER);
    this.texture.needsUpdate = true;
  }
}
