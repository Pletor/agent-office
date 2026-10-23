// The pick flying across the room: when the orchestrator's card changes (someone switched a page on at
// the 🎚️ switchboard on the north glass), a "🎯 card" chip rises off the switchboard and arcs over to
// the top of the purple board on the west wall, drawing its trail, as in the design "Místnost –
// rozložení". When it lands the ledge and the board's card bar light up (see `landedAt`).

import * as THREE from 'three';
import { PLANNING_BOARD, PLANNING_ROOM } from '../../../shared/planning';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';

/** How long the chip takes to fly, and how long what it lands on stays lit. */
export const BEAM_MS = 1200;
export const LIT_MS = 1400;

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';

/** Where it leaves from (the switchboard, high on the inside of the north glass) and lands (the purple board's top edge). */
export function beamCurve(): THREE.QuadraticBezierCurve3 {
  const R = PLANNING_ROOM, B = PLANNING_BOARD;
  const from = new THREE.Vector3((R.minX + R.maxX) / 2 - 0.6, 2.05, R.minZ + 0.12);
  const to = new THREE.Vector3(B.x + 0.14, B.bottom + B.height - 0.12, B.z - 0.4);
  const mid = from.clone().lerp(to, 0.5);
  mid.y = Math.max(from.y, to.y) + 0.45;
  return new THREE.QuadraticBezierCurve3(from, mid, to);
}

/** Where along the flight the chip is at `k` (0–1): eased, slow out and slow in. */
export const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

export class CardBeam {
  readonly group = new THREE.Group();
  private chip: THREE.Sprite;
  private trail: THREE.Line;
  private label = canvasTexture(512, 96);
  private curve = beamCurve();
  private start = -1;
  /** When the last chip landed (performance.now()), for what lights up. */
  landedAt = -Infinity;

  constructor() {
    this.chip = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.label.texture, depthTest: false, transparent: true }));
    this.chip.scale.set(0.72, 0.135, 1);
    this.chip.renderOrder = 10;
    const pts = this.curve.getPoints(48);
    this.trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#9b5de5', dashSize: 0.08, gapSize: 0.05, transparent: true, depthTest: false }));
    this.trail.computeLineDistances();
    this.trail.renderOrder = 9;
    this.group.add(this.trail, this.chip);
    this.group.visible = false;
  }

  /** Sends a chip with `name` on it. */
  fly(name: string, now: number) {
    const { g, canvas, texture } = this.label;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#efe4fb';
    g.strokeStyle = '#2b2d42';
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 44);
    g.fill();
    g.stroke();
    g.fillStyle = '#2b2d42';
    g.font = `900 46px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(fit(g, `🎯 ${name}`, canvas.width - 50), canvas.width / 2, canvas.height / 2 + 2);
    texture.needsUpdate = true;
    this.start = now;
    this.group.visible = true;
  }

  /** Moves the chip along; returns whether it's still in the air. */
  tick(now: number): boolean {
    if (this.start < 0) return false;
    const k = Math.min(1, (now - this.start) / BEAM_MS);
    this.chip.position.copy(this.curve.getPoint(ease(k)));
    const geo = this.trail.geometry;
    geo.setDrawRange(0, Math.max(2, Math.round(49 * ease(k))));
    (this.trail.material as THREE.LineDashedMaterial).opacity = k < 1 ? 0.9 : 0.9 * Math.max(0, 1 - (now - this.start - BEAM_MS) / 500);
    if (k >= 1 && this.landedAt < this.start) this.landedAt = now;
    if (k >= 1 && now - this.start > BEAM_MS + 500) {
      this.start = -1;
      this.group.visible = false;
      return false;
    }
    return true;
  }

  /** How lit what it lands on is now (1 just landed, fading to 0). */
  lit(now: number): number {
    const t = now - this.landedAt;
    return t >= 0 && t < LIT_MS ? 1 - t / LIT_MS : 0;
  }
}
