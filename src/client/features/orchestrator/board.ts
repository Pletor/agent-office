// What the orchestrator's two boards show: the card picked for it (name, area, where it is), or how to
// pick one. Painted on canvases, like the switchboard under the plate.

import type * as THREE from 'three';
import type { OporaCard, OporaState, OrchestratorState } from '../../../shared/protocol';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';
import { STATUS_CZ } from '../opora-plan/cards';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
const PAPER = '#fffaf3';
const PURPLE = '#9b5de5';
const STATUS_COLOR: Record<OporaCard['status'], string> = {
  frontier: '#38d9a9', claimed: '#5bc0eb', blocked: '#ef476f', waiting: '#ffd166', closed: '#adb5bd', needsRouting: '#ff8a5b',
};

export interface Shown {
  state: OrchestratorState;
  opora: OporaState;
}

/** The focused card as the canvas has it now, and a line saying where it is. */
export function focusedCard(s: Shown): { card?: OporaCard; name: string; where: string } | undefined {
  const f = s.state.focus;
  if (!f) return undefined;
  const card = s.opora.cards.find((c) => c.id === f.cardId);
  const where = card
    ? [card.sectorName || 'bez oblasti', STATUS_CZ[card.status] ?? card.status, card.stage ? `etapa ${card.stage}` : card.profile ? `profil ${card.profile}` : 'bez pipeline'].join(' · ')
    : 'karta teď není na canvasu';
  return { card, name: card?.name ?? f.name, where };
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

/** The right board's plate: "🎯 Karta pro orchestrátora", the card's name, and where it is. */
export class PickerPlateTexture {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private W = 1680;
  private H = 136;

  constructor() {
    const c = canvasTexture(this.W, this.H);
    this.g = c.g;
    this.texture = c.texture;
  }

  render(s: Shown) {
    const { g, W, H } = this;
    g.fillStyle = INK;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#ffd166';
    g.font = `900 30px ${FONT}`;
    g.fillText('🎯 KARTA PRO ORCHESTRÁTORA', 24, 34);
    const shown = focusedCard(s);
    if (!shown) {
      g.fillStyle = PAPER;
      g.font = `800 40px ${FONT}`;
      g.fillText(!s.opora.project ? 'Patro není propojené s Oporou' : 'Žádná karta · E vybrat kartu', 24, 92);
    } else {
      const st = shown.card ? STATUS_COLOR[shown.card.status] : '#adb5bd';
      g.fillStyle = PAPER;
      g.font = `900 46px ${FONT}`;
      g.fillText(fit(g, shown.name, W - 640), 24, 92);
      g.textAlign = 'right';
      g.fillStyle = '#cfd3dc';
      g.font = `800 28px ${FONT}`;
      g.fillText(fit(g, shown.where, 560), W - 24, 92);
      pill(g, s.state.brief ? 'orchestrátor ji vidí' : 'čtu z Opory…', W - 20, 34, 40, st, INK);
    }
    this.texture.needsUpdate = true;
  }
}

/** The purple board's ledge: the same card, and that E opens both designs of it. */
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

  render(s: Shown) {
    const { g, W, H } = this;
    g.fillStyle = PURPLE;
    g.fillRect(0, 0, W, H);
    g.fillStyle = PAPER;
    g.fillRect(10, 10, W - 20, H - 20);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = PURPLE;
    g.font = `900 34px ${FONT}`;
    g.fillText('🔎 DETAIL KARTY · Lens + Design karta', 34, 50);
    const shown = focusedCard(s);
    g.fillStyle = INK;
    if (!shown) {
      g.font = `800 40px ${FONT}`;
      g.fillText('Vyber kartu na pravé tabuli (sever)', 34, 120);
    } else {
      g.font = `900 50px ${FONT}`;
      g.fillText(fit(g, shown.name, W - 420), 34, 118);
      g.textAlign = 'right';
      g.font = `800 28px ${FONT}`;
      g.fillStyle = '#5c5470';
      g.fillText(fit(g, shown.card?.sectorName || '', 340), W - 34, 50);
    }
    pill(g, 'E · otevřít', W - 30, 118, 54, INK, PAPER);
    this.texture.needsUpdate = true;
  }
}
