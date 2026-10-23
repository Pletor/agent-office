import type * as THREE from 'three';
import type { OporaState, OrchestratorState, PlanningState } from '../../../shared/protocol';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';
import type { RoomNote } from './data';
import { paintDesign, type StripInput } from './design-strip';
import { paintLayers } from './layers';
import type { PlanView } from './model';
import { ago, box, FONT, INK, MUTED, PURPLE, title } from './paint';

const MAX_FEED = 12;

export interface LiveInput {
  opora: OporaState;
  orchestrator: OrchestratorState;
  planning: PlanningState;
  plan: PlanView;
  /** The orchestrator's card on the design pipeline, for "Design karta v procesu". */
  design?: StripInput;
  notes: readonly RoomNote[];
  /** How lit the card bar is (1 the card just landed, fading to 0). */
  lit: number;
}

/**
 * The live canvas on the planning room's purple board, as the design "Místnost – rozložení" has it:
 * the project and a light that blinks while the agents are at it; the orchestrator's card (the deepest
 * page switched on at the 🎚️ switchboard), lit as it lands; on the left its plan by layers, area →
 * sector → node, and for a design card its seven stages and how it will look; on the right what the
 * agents just did on the canvas and what happened in the room.
 */
export class LiveCanvasTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1700, 950);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(d: LiveInput, now = Date.now()) {
    const { g } = this;
    const s = d.opora;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#fbfaff';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'middle';
    // Across the top: the project, and a light that blinks while the agents are at it.
    g.fillStyle = INK;
    g.fillRect(0, 0, W, 72);
    g.fillStyle = '#fffaf3';
    g.font = `900 36px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(fit(g, `🛰️ Canvas živě · ${s.project?.name ?? ''}`, W - 520), 26, 37);
    const last = s.activity[0];
    const fresh = last && now - Date.parse(last.at) < 60_000;
    g.fillStyle = fresh && Math.floor(now / 600) % 2 ? '#ff6b6b' : fresh ? '#c92a2a' : '#868e96';
    g.beginPath();
    g.arc(W - 330, 37, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fffaf3';
    g.font = `800 26px ${FONT}`;
    g.fillText(last ? `ŽIVĚ · před ${ago(last.at, now)}` : 'ŽIVĚ · zatím ticho', W - 310, 37);

    this.cardBar(d, 26, 86, W - 52, 58);
    const fx = W - 26 - 520;
    const lw = fx - 26 - 24;
    if (d.design) {
      paintLayers(g, s, d.plan, 26, 164, lw, 400);
      paintDesign(g, d.design, 26, 580, lw, H - 580 - 20, now);
    } else paintLayers(g, s, d.plan, 26, 164, lw, H - 164 - 20);
    this.feed(d, now, fx, 164, 520, H - 164 - 20);
    this.texture.needsUpdate = true;
  }

  /** The orchestrator's card, where it is, and the planner at the table. */
  private cardBar(d: LiveInput, x: number, y: number, w: number, h: number) {
    const { g } = this;
    const k = d.lit;
    box(g, x, y, w, h, 14, k ? `rgb(${Math.round(239 + 16 * k)}, ${Math.round(228 - 18 * k)}, ${Math.round(251 - 140 * k)})` : '#efe4fb', PURPLE, 3 + 3 * k);
    g.textAlign = 'left';
    g.fillStyle = INK;
    g.font = `900 28px ${FONT}`;
    const card = d.plan.cardId ? d.plan.name ?? '' : '';
    g.fillText(fit(g, `🎯 Karta pro orchestrátora: ${card || '—'}`, w * 0.55), x + 18, y + h / 2);
    g.textAlign = 'right';
    g.fillStyle = '#5c5470';
    g.font = `800 20px ${FONT}`;
    const path = d.plan.path.map((n) => n.name).join(' › ');
    const p = d.planning.current;
    const planner = p?.status === 'planning' ? `🧭 ${p.workerName ?? 'Plánovač'} plánuje` : d.orchestrator.brief ? '🧭 plánovač ji má v zadání' : card ? '🧭 skládám přehled z Opory…' : '';
    g.fillText(fit(g, [path, planner].filter(Boolean).join('  ·  ') || 'žádná karta: zapni stránku na 🎚️ Zaměření buňky', w * 0.42), x + w - 18, y + h / 2);
  }

  /** What the agents just did on the canvas and what happened in the room, newest first; the card's own marked. */
  private feed(d: LiveInput, now: number, x: number, y: number, w: number, h: number) {
    const { g } = this;
    const s = d.opora;
    title(g, 'Co dělají agenti', x, y);
    const mine = new Set([d.plan.cardId, ...d.plan.areas.flatMap((a) => [a.area?.id, ...a.sectors.flatMap((x) => [x.sector?.id, ...x.nodes.map((n) => n.node.id)])])].filter(Boolean) as string[]);
    const names = new Map(s.scope.map((n) => [n.id, n.name]));
    for (const a of d.plan.areas) for (const sec of a.sectors) for (const n of sec.nodes) names.set(n.node.id, n.node.name);
    type Row = { at: number; who: string; what: string; where: string; me: boolean; card: boolean; ok: boolean };
    const rows: Row[] = [
      ...d.notes.map((n) => ({ at: n.at, who: n.who, what: n.what, where: '', me: true, card: true, ok: true })),
      ...s.activity.map((e) => ({ at: Date.parse(e.at), who: e.agent.replace(/^office-/, ''), what: e.what, where: e.nodeIds.map((id) => names.get(id) ?? id.slice(0, 8)).join(', '), me: false, card: e.nodeIds.some((id) => mine.has(id)), ok: e.ok })),
    ].sort((a, b) => b.at - a.at).slice(0, MAX_FEED);
    if (!rows.length) {
      g.fillStyle = MUTED;
      g.font = `800 22px ${FONT}`;
      g.textAlign = 'left';
      g.fillText('Zatím nic.', x, y + 70);
      return;
    }
    const row = Math.min(70, (h - 44) / MAX_FEED);
    rows.forEach((e, i) => {
      const ry = y + 40 + i * row;
      box(g, x, ry, w, row - 6, 10, e.me ? '#efe4fb' : i === 0 && now - e.at < 30_000 ? '#fff9db' : i % 2 ? '#f8f9fa' : '#ffffff', e.card ? PURPLE : undefined, 2);
      g.textAlign = 'left';
      g.fillStyle = e.ok ? INK : '#c92a2a';
      g.font = `900 19px ${FONT}`;
      g.fillText(fit(g, `${e.card && !e.me ? '🎯 ' : ''}${e.who} ${e.what}`, w - 90), x + 10, ry + row * 0.3);
      g.fillStyle = '#495057';
      g.font = `700 16px ${FONT}`;
      if (e.where) g.fillText(fit(g, e.where, w - 20), x + 10, ry + row * 0.64);
      g.textAlign = 'right';
      g.fillStyle = MUTED;
      g.font = `800 16px ${FONT}`;
      g.fillText(ago(e.at, now), x + w - 10, ry + row * 0.3);
    });
  }
}
