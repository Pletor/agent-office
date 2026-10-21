import { ProcessGraph, svgEl, type Position } from './graph';
import type { StudioState } from './model';

interface Spider { group: SVGGElement; legs: SVGPathElement[]; at: Position; target: Position; phase: number; moving: boolean }
/** Visual interpolation never delays, advances or approves a workflow event. */
export class SpiderMotion {
  private spiders = new Map<string, Spider>();
  private last = 0;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private running = true;
  private frame = 0;
  constructor(private graph: ProcessGraph) {
    for (const [index, [id, color, start]] of [
      ['planner', '#ff78b5', 'plan'], ['developer', '#6fe2dc', 'office'], ['reviewer', '#edc180', 'checks'], ['memory', '#b99aff', 'recall'],
    ].entries()) {
      const g = svgEl('g', { class: 'spider', style: `--spider:${color}` }, graph.actors);
      svgEl('circle', { r: 20, class: 'spider-aura' }, g);
      const legs = Array.from({ length: 8 }, () => svgEl('path', { class: 'spider-leg', fill: 'none' }, g));
      svgEl('ellipse', { rx: 8, ry: 10, class: 'spider-body' }, g);
      svgEl('circle', { cy: -10, r: 5, class: 'spider-head' }, g);
      svgEl('circle', { cx: -2, cy: -12, r: 1.1, fill: '#0b0d15' }, g);
      svgEl('circle', { cx: 2, cy: -12, r: 1.1, fill: '#0b0d15' }, g);
      const at = graph.position(start);
      this.spiders.set(id, { group: g, legs, at: { ...at }, target: at, phase: index, moving: false });
    }
    this.frame = requestAnimationFrame(t => this.tick(t));
  }
  update(s: StudioState, running: boolean) {
    this.running = running;
    const spider = this.spiders.get(s.actor);
    if (spider) spider.target = this.graph.position(s.active);
    // The second worker stays active while the first completes its own branch.
    if (s.nodes.backend.status === 'working') this.spiders.get('reviewer')!.target = this.graph.position('backend');
    if (s.nodes.frontend.status === 'working') this.spiders.get('developer')!.target = this.graph.position('frontend');
    for (const [id, actor] of this.spiders) actor.group.classList.toggle('engaged', id === s.actor);
    if (!running || this.reduced.matches) for (const actor of this.spiders.values()) actor.at = { ...actor.target };
  }
  private tick(t: number) {
    const dt = Math.min((t - this.last) / 1000, 0.05); this.last = t;
    for (const spider of this.spiders.values()) {
      const dx = spider.target.x - spider.at.x, dy = spider.target.y - spider.at.y;
      const distance = Math.hypot(dx, dy);
      spider.moving = distance > 1 && this.running && !this.reduced.matches;
      if (spider.moving) {
        const step = Math.min(distance, 260 * dt);
        spider.at.x += dx / distance * step; spider.at.y += dy / distance * step;
      }
      if (this.running && !this.reduced.matches) spider.phase += dt * (spider.moving ? 14 : 2);
      spider.group.setAttribute('transform', `translate(${spider.at.x.toFixed(2)} ${spider.at.y.toFixed(2)})`);
      spider.legs.forEach((leg, i) => {
        const side = i < 4 ? -1 : 1, n = i % 4;
        const gait = Math.sin(spider.phase + n * 1.6 + (side > 0 ? Math.PI : 0)) * (spider.moving ? 5 : 1.2);
        const y = (n - 1.5) * 6;
        leg.setAttribute('d', `M${side * 5} ${y} Q${side * (15 + gait)} ${y - 8} ${side * (23 + gait)} ${y + (n - 1.5) * 7 + gait}`);
      });
    }
    this.frame = requestAnimationFrame(time => this.tick(time));
  }
  destroy() { cancelAnimationFrame(this.frame); }
}
