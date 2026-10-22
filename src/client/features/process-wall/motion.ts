// The wall's motion, only ever because an event arrived: a marker slides when its lane's phase
// changes (450 ms ease-out), a tool call pulses once (900 ms), a failure shakes (400 ms). The first
// look at a lane is a baseline, never news. Reduced motion: nothing moves.

import type { Lane } from './lanes';

export const MOVE_MS = 450;
export const PULSE_MS = 900;
export const SHAKE_MS = 400;

interface Seen { phase: number; lastId?: string }
interface Anim { from: number; to: number; moveAt: number; pulseAt: number; shakeAt: number }

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export class WallMotion {
  private seen = new Map<string, Seen>();
  private anims = new Map<string, Anim>();
  private started = false;

  /** Takes the lanes in after an event or state change, starting what their changes call for. */
  observe(lanes: readonly Lane[], now: number, reduced: boolean) {
    const next = new Map<string, Seen>();
    for (const lane of lanes) {
      const was = this.seen.get(lane.key);
      next.set(lane.key, { phase: lane.phase, lastId: lane.last?.id });
      if (!this.started || reduced || !was || !lane.last || lane.last.id === was.lastId) continue;
      const a = this.anims.get(lane.key) ?? { from: lane.phase, to: lane.phase, moveAt: -1, pulseAt: -1, shakeAt: -1 };
      if (was.phase !== lane.phase) { a.from = this.phaseAt(lane.key, was.phase, now); a.to = lane.phase; a.moveAt = now; }
      if (lane.last.kind === 'tool.use' && lane.last.state !== 'fail') a.pulseAt = now;
      if (lane.last.state === 'fail') a.shakeAt = now;
      this.anims.set(lane.key, a);
    }
    this.seen = next;
    this.started = true;
    if (reduced) this.anims.clear();
  }

  /** Whether anything still moves, so the wall keeps redrawing until it settles. */
  active(now: number): boolean {
    for (const [key, a] of this.anims) {
      if (now - a.moveAt < MOVE_MS || now - a.pulseAt < PULSE_MS || now - a.shakeAt < SHAKE_MS) return true;
      this.anims.delete(key);
    }
    return false;
  }

  /** Where the marker is, in phase columns (fractional while sliding). */
  phaseAt(key: string, phase: number, now: number): number {
    const a = this.anims.get(key);
    if (!a || a.to !== phase || a.moveAt < 0 || now - a.moveAt >= MOVE_MS) return phase;
    return a.from + (a.to - a.from) * easeOut((now - a.moveAt) / MOVE_MS);
  }

  /** 0..1 through the pulse, or -1. */
  pulse(key: string, now: number): number {
    const a = this.anims.get(key);
    return a && a.pulseAt >= 0 && now - a.pulseAt < PULSE_MS ? (now - a.pulseAt) / PULSE_MS : -1;
  }

  /** Horizontal shake in px (±6). */
  shake(key: string, now: number): number {
    const a = this.anims.get(key);
    if (!a || a.shakeAt < 0 || now - a.shakeAt >= SHAKE_MS) return 0;
    const t = (now - a.shakeAt) / SHAKE_MS;
    return Math.sin(t * Math.PI * 4) * 6;
  }

  reset() { this.seen.clear(); this.anims.clear(); this.started = false; }
}
