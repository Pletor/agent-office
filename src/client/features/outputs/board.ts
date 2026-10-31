// What the Výstupy ledge shows: its name, how many PRs went into main in the last days and how many of
// them have an output ("12 PR · 9 s výstupem · 3 bez"), and that E opens the detail. Painted on a
// canvas, like the orchestrator's ledge.

import type * as THREE from 'three';
import { countsLine, type OutputsBoard } from '../../../shared/outputs';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
const PAPER = '#fffaf3';
const PURPLE = '#9b5de5';
const RED = '#d62839';

export interface OutputsView {
  loading: boolean;
  data?: OutputsBoard;
  error?: string;
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

export class OutputsLedgeTexture {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private W = 1500;
  private H = 225;

  constructor() {
    const c = canvasTexture(this.W, this.H);
    this.g = c.g;
    this.texture = c.texture;
  }

  render(v: OutputsView) {
    const { g, W, H } = this;
    g.fillStyle = PURPLE;
    g.fillRect(0, 0, W, H);
    g.fillStyle = PAPER;
    g.fillRect(10, 10, W - 20, H - 20);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = PURPLE;
    g.font = `900 34px ${FONT}`;
    g.fillText('🗂️ VÝSTUPY · Čistá linie', 34, 52);
    const d = v.data;
    g.textAlign = 'right';
    g.font = `800 28px ${FONT}`;
    g.fillStyle = '#5c5470';
    g.fillText(fit(g, d ? `${d.repo.label} · ${d.repo.main} · ${d.days} dní` : '', 620), W - 34, 52);
    g.textAlign = 'left';
    if (!d) {
      g.fillStyle = INK;
      g.font = `800 44px ${FONT}`;
      g.fillText(fit(g, v.error ?? (v.loading ? 'Čtu sloučené PR…' : 'Žádná data'), W - 420), 34, 145);
    } else {
      const c = d.counts;
      g.font = `900 64px ${FONT}`;
      g.fillStyle = INK;
      const head = `${c.merged} PR · ${c.with} s výstupem · `;
      g.fillText(head, 34, 145);
      const x = 34 + g.measureText(head).width;
      g.fillStyle = c.without ? RED : '#3b6d3f';
      g.fillText(`${c.without} bez`, x, 145);
      if (d.note) {
        g.font = `700 22px ${FONT}`;
        g.fillStyle = '#8a5f0f';
        g.fillText(fit(g, d.note, W - 420), 34, 196);
      }
    }
    pill(g, 'E · otevřít', W - 30, 145, 58, INK, PAPER);
    this.texture.needsUpdate = true;
  }
}

/** The line the ledge and the hint say about the counts. */
export const summary = (v: OutputsView) => (v.data ? countsLine(v.data.counts) : v.error ? 'nelze načíst' : 'čtu…');
