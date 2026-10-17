import type * as THREE from 'three';
import type { PlanningState, QueueState, QueueTask } from '../../../shared/protocol';
import { canvasTexture, wrap } from '../boards/meeting';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const INK = '#2b2d42';
const PURPLE = '#9b5de5';

/** How a plan's task is getting on, once it's on the queue: its icon and its words. */
export function taskProgress(queueId: string | undefined, queue: QueueState): { icon: string; words: string; task?: QueueTask } {
  if (!queueId) return { icon: '◻️', words: 'not on the queue yet' };
  const task = queue.tasks.find((t) => t.id === queueId);
  if (!task) return { icon: '🗂️', words: 'taken off the queue' };
  if (task.status === 'queued') return { icon: '⏳', words: 'waiting on the queue', task };
  if (task.status === 'running') return { icon: '🛠️', words: `${task.workerName ?? 'a worker'} is on it`, task };
  if (task.pr) return { icon: task.pr.state === 'MERGED' ? '🎉' : '🔀', words: `PR #${task.pr.number}`, task };
  return { icon: task.outcome === 'done' ? '✅' : '⚠️', words: task.outcome === 'done' ? 'done' : (task.outcome ?? 'finished'), task };
}

/**
 * The board in the planning room: the plan as the planner writes it, and once it's ready, its tasks,
 * with how each is getting on once it's on the queue.
 */
export class PlanningBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    const c = canvasTexture(1360, 760);
    this.canvas = c.canvas;
    this.g = c.g;
    this.texture = c.texture;
  }

  render(state: PlanningState, queue: QueueState) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#fbfaff';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    const p = state.current;
    // Across the top: the department, and where the plan is.
    g.fillStyle = PURPLE;
    g.fillRect(0, 0, W, 76);
    g.fillStyle = '#fffaf3';
    g.font = `900 40px ${FONT}`;
    g.textAlign = 'left';
    g.fillText('🧭 Opora Control Center', 26, 52);
    g.textAlign = 'right';
    g.font = `800 32px ${FONT}`;
    const status = !p ? 'free' : p.status === 'planning' ? `✍️ ${p.workerName ?? 'the planner'} is planning` : p.status === 'ready' ? '📋 ready to hand over' : p.status === 'queued' ? '🛠️ on the queue' : '⛔ stopped';
    g.fillText(status, W - 26, 52);
    g.textAlign = 'left';

    if (!p) {
      g.fillStyle = INK;
      g.textAlign = 'center';
      g.font = `900 60px ${FONT}`;
      g.fillText('The planning room is free', W / 2, H / 2 - 20);
      g.font = `700 34px ${FONT}`;
      g.fillStyle = '#5c5f73';
      for (const [i, l] of wrap(g, 'Press E at the table to ask for a plan. Its tasks go on the 📋 task queue, for the other workers to carry out.', W - 160).entries()) g.fillText(l, W / 2, H / 2 + 46 + i * 44);
      g.textAlign = 'left';
      this.texture.needsUpdate = true;
      return;
    }

    g.fillStyle = INK;
    g.font = `900 46px ${FONT}`;
    g.fillText(wrap(g, p.title, W - 60)[0] ?? '', 30, 138);
    g.font = `700 26px ${MONO}`;
    g.fillStyle = '#8d99ae';
    g.fillText(`📄 ${p.file}`, 30, 178);

    let y = 236;
    if (p.tasks.length && p.status !== 'planning') {
      // The tasks, each with how it's getting on.
      for (const [i, t] of p.tasks.entries()) {
        if (y > H - 20) {
          g.fillStyle = '#8d99ae';
          g.font = `800 28px ${FONT}`;
          g.fillText(`…and ${p.tasks.length - i} more`, 30, y);
          break;
        }
        const prog = taskProgress(t.queueId, queue);
        g.font = `800 32px ${FONT}`;
        g.fillStyle = INK;
        g.fillText(`${prog.icon} ${i + 1}. ${wrap(g, t.title, W - 520)[0] ?? ''}`, 30, y);
        g.textAlign = 'right';
        g.font = `700 26px ${FONT}`;
        g.fillStyle = '#5c5f73';
        g.fillText(prog.words, W - 30, y);
        g.textAlign = 'left';
        y += 50;
      }
      this.texture.needsUpdate = true;
      return;
    }
    // Being written: the start of the file, markdown-ish.
    const text = (p.preview ?? '').replace(/\r/g, '');
    if (!text.trim()) {
      g.fillStyle = '#8d99ae';
      g.font = `800 40px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(p.status === 'stopped' ? `⛔ ${p.reason ?? 'stopped'}` : 'Nothing written yet: the planner is reading up', W / 2, H / 2 + 60);
      g.textAlign = 'left';
      this.texture.needsUpdate = true;
      return;
    }
    for (const raw of text.split('\n')) {
      if (y > H - 14) break;
      const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
      const line = heading ? heading[2] : raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
      const size = heading ? 34 : 26;
      g.font = heading ? `900 ${size}px ${FONT}` : `600 ${size}px ${FONT}`;
      g.fillStyle = heading ? INK : '#3d405b';
      if (!line.trim()) {
        y += size * 0.5;
        continue;
      }
      for (const l of wrap(g, line, W - 60)) {
        if (y > H - 14) break;
        g.fillText(l, 30, y);
        y += size * 1.25;
      }
    }
    this.texture.needsUpdate = true;
  }
}
