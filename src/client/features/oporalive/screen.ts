import type * as THREE from 'three';
import { cleanFocus, focusLeaves, focusPaths, inFocus, SCOPE_LEVEL_NAME } from '../../../shared/opora-scope';
import type { OporaCard, OporaState, PlanningState } from '../../../shared/protocol';
import { canvasTexture } from '../boards/meeting';
import { fit } from '../oporascope/screen';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
const GREEN = '#38d9a9';
const PURPLE = '#9b5de5';

/** Each card status's colour and words, in the order the board lists them. */
const STATUS: [OporaCard['status'], string, string][] = [
  ['claimed', '#4dabf7', 'v práci'],
  ['frontier', GREEN, 'volná'],
  ['blocked', '#ffa94d', 'blokovaná'],
  ['waiting', '#ffd43b', 'čeká na člověka'],
  ['needsRouting', '#ced4da', 'bez pipeline'],
  ['closed', '#adb5bd', 'hotová'],
];
const MAX_TILES = 12;
const MAX_FEED = 9;

/** How long ago `at` was, shortly: 5 s, 3 min, 2 h. */
function ago(at: string | number, now: number): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

/**
 * The live canvas on the planning room's board: on the left the way down to what the cell works
 * on, a step at a time; in the middle the cards there, with who's on each; on the right what the
 * agents just did on the canvas; along the bottom the planner at the table handing the work out.
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

  render(s: OporaState, planning: PlanningState, now = Date.now()) {
    const { g } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#fbfaff';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'middle';
    // Across the top: the project, and a light that blinks while the agents are at it.
    g.fillStyle = INK;
    g.fillRect(0, 0, W, 76);
    g.fillStyle = '#fffaf3';
    g.font = `900 38px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(fit(g, `🛰️ Canvas živě · ${s.project?.name ?? ''}`, W - 520), 26, 39);
    const last = s.activity[0];
    const fresh = last && now - Date.parse(last.at) < 60_000;
    g.fillStyle = fresh && Math.floor(now / 600) % 2 ? '#ff6b6b' : fresh ? '#c92a2a' : '#868e96';
    g.beginPath();
    g.arc(W - 330, 39, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fffaf3';
    g.font = `800 28px ${FONT}`;
    g.fillText(last ? `ŽIVĚ · před ${ago(last.at, now)}` : 'ŽIVĚ · zatím ticho', W - 310, 39);

    const focus = cleanFocus(s.scope, s.focus);
    this.path(s, focus, 26, 100, 470, H - 200);
    this.cards(s, focus, 520, 100, 690, H - 200);
    this.feed(s, now, 1236, 100, W - 1236 - 26, H - 200);
    this.handout(s, planning, 26, H - 84, W - 52);
    this.texture.needsUpdate = true;
  }

  /** The way down to the focus: environment, domain, page, subpage, each a step further in. */
  private path(s: OporaState, focus: string[], x: number, y: number, w: number, h: number) {
    const { g } = this;
    title(g, 'Cesta k úkolu', x, y);
    const paths = focusPaths(s.scope, focus);
    const way = paths[0] ?? [];
    if (!way.length) {
      g.fillStyle = '#868e96';
      g.font = `800 26px ${FONT}`;
      g.textAlign = 'left';
      g.fillText('Celý projekt', x, y + 70);
      g.font = `700 22px ${FONT}`;
      g.fillText('Zaměř buňku na 🎚️ přepínači', x, y + 108);
      g.fillText('na severní stěně.', x, y + 138);
      return;
    }
    const step = Math.min(120, (h - 60) / way.length);
    way.forEach((n, i) => {
      const bx = x + i * 34;
      const by = y + 44 + i * step;
      const bw = w - i * 34;
      const leaf = i === way.length - 1;
      if (i) {
        g.strokeStyle = PURPLE;
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(bx - 18, by - step + 70);
        g.lineTo(bx - 18, by + 34);
        g.lineTo(bx, by + 34);
        g.stroke();
      }
      g.fillStyle = leaf ? '#f3f0ff' : '#ffffff';
      g.strokeStyle = leaf ? PURPLE : '#ced4da';
      g.lineWidth = leaf ? 5 : 3;
      g.beginPath();
      g.roundRect(bx, by, bw, 70, 14);
      g.fill();
      g.stroke();
      g.textAlign = 'left';
      g.fillStyle = '#868e96';
      g.font = `900 17px ${FONT}`;
      g.fillText(SCOPE_LEVEL_NAME[n.level].toUpperCase(), bx + 16, by + 20);
      g.fillStyle = INK;
      g.font = `${leaf ? 900 : 800} 27px ${FONT}`;
      g.fillText(fit(g, n.host ? `${n.name} · ${n.host}` : n.name, bw - 32), bx + 16, by + 48);
    });
    if (paths.length > 1) {
      g.fillStyle = '#868e96';
      g.font = `800 20px ${FONT}`;
      g.fillText(`+ ${paths.length - 1} další zaměření`, x, y + h - 10);
    }
  }

  /**
   * The pages and subpages in the focus (its cards on the canvas), the ones being worked on first,
   * each with its status on the canvas when it has one and its worker when the office is on it.
   */
  private cards(s: OporaState, focus: string[], x: number, y: number, w: number, h: number) {
    const { g } = this;
    const leaves = new Set(focusLeaves(s.scope, focus));
    const status = new Map(s.cards.map((c) => [c.id, c]));
    const order = (id: string) => {
      const i = STATUS.findIndex(([st]) => st === status.get(id)?.status);
      return i < 0 ? STATUS.length : i;
    };
    const mine = s.scope.filter((n) => (n.level === 'page' || n.level === 'subpage') && inFocus(s.scope, focus, n.id)).sort((a, b) => order(a.id) - order(b.id));
    title(g, `Karty v zaměření · ${mine.length}`, x, y);
    if (!mine.length) {
      g.fillStyle = '#868e96';
      g.font = `800 24px ${FONT}`;
      g.textAlign = 'left';
      g.fillText('Tady zatím žádná karta není.', x, y + 70);
      return;
    }
    const cols = 2;
    const tw = (w - 16) / cols;
    const th = Math.min(96, (h - 50) / Math.ceil(Math.min(MAX_TILES, mine.length) / cols) - 12);
    mine.slice(0, MAX_TILES).forEach((n, i) => {
      const tx = x + (i % cols) * (tw + 16);
      const ty = y + 44 + Math.floor(i / cols) * (th + 12);
      const c = status.get(n.id);
      const [, color, words] = STATUS[order(n.id)] ?? [undefined, '#e9ecef', 'na canvasu'];
      const run = s.runs.find((r) => r.cardId === n.id && r.state !== 'gone');
      g.fillStyle = '#ffffff';
      g.strokeStyle = leaves.has(n.id) ? PURPLE : INK;
      g.lineWidth = 3;
      g.beginPath();
      g.roundRect(tx, ty, tw, th, 12);
      g.fill();
      g.stroke();
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(tx, ty, 12, th, [12, 0, 0, 12]);
      g.fill();
      g.textAlign = 'left';
      g.fillStyle = INK;
      g.font = `900 24px ${FONT}`;
      g.fillText(fit(g, n.name, tw - 40), tx + 26, ty + th * 0.36);
      g.fillStyle = '#495057';
      g.font = `700 19px ${FONT}`;
      const who = run ? `${run.state === 'done' ? '✅' : '🧑‍💻'} ${run.workerName ?? 'pracovník'}` : words;
      g.fillText(fit(g, [who, c?.stage, c?.group === 'design' ? 'design' : ''].filter(Boolean).join(' · '), tw - 40), tx + 26, ty + th * 0.72);
    });
    if (mine.length > MAX_TILES) {
      g.fillStyle = '#868e96';
      g.font = `800 20px ${FONT}`;
      g.fillText(`+ ${mine.length - MAX_TILES} dalších`, x, y + h - 10);
    }
  }

  /** What the agents just did on the canvas, newest first. */
  private feed(s: OporaState, now: number, x: number, y: number, w: number, h: number) {
    const { g } = this;
    title(g, 'Co dělají agenti', x, y);
    const names = new Map(s.scope.map((n) => [n.id, n.name]));
    if (!s.activity.length) {
      g.fillStyle = '#868e96';
      g.font = `800 22px ${FONT}`;
      g.textAlign = 'left';
      g.fillText('Zatím nic.', x, y + 70);
      return;
    }
    const row = Math.min(80, (h - 50) / MAX_FEED);
    s.activity.slice(0, MAX_FEED).forEach((e, i) => {
      const ry = y + 44 + i * row;
      g.fillStyle = i === 0 && now - Date.parse(e.at) < 30_000 ? '#fff9db' : i % 2 ? '#f8f9fa' : '#ffffff';
      g.fillRect(x, ry, w, row - 6);
      g.textAlign = 'left';
      g.fillStyle = e.ok ? INK : '#c92a2a';
      g.font = `900 20px ${FONT}`;
      g.fillText(fit(g, `${e.agent.replace(/^office-/, '')} ${e.what}`, w - 80), x + 10, ry + row * 0.3);
      g.fillStyle = '#495057';
      g.font = `700 18px ${FONT}`;
      g.fillText(fit(g, e.nodeIds.map((id) => names.get(id) ?? id.slice(0, 8)).join(', ') || '—', w - 20), x + 10, ry + row * 0.66);
      g.textAlign = 'right';
      g.fillStyle = '#868e96';
      g.font = `800 17px ${FONT}`;
      g.fillText(ago(e.at, now), x + w - 10, ry + row * 0.3);
    });
  }

  /** Along the bottom: the planner at the table, and who's on their way with work. */
  private handout(s: OporaState, planning: PlanningState, x: number, y: number, w: number) {
    const { g } = this;
    g.fillStyle = '#f3f0ff';
    g.beginPath();
    g.roundRect(x, y - 30, w, 64, 14);
    g.fill();
    const p = planning.current;
    const lead = p?.status === 'planning' ? `🧭 ${p.workerName ?? 'Plánovač'} tvoří na canvasu: ${p.title}` : p ? `🧭 Plán „${p.title}“ je na canvasu` : '🧭 Plánovač u stolu je volný';
    const runs = s.runs.filter((r) => r.state === 'working').map((r) => `${r.workerName ?? '?'} → ${r.cardName}`);
    g.textAlign = 'left';
    g.fillStyle = INK;
    g.font = `900 24px ${FONT}`;
    g.fillText(fit(g, lead, w * 0.5), x + 18, y + 2);
    g.textAlign = 'right';
    g.font = `800 22px ${FONT}`;
    g.fillText(fit(g, runs.length ? `Rozdáno: ${runs.join(' · ')}` : s.autopilot ? '🤖 Autopilot rozdává volné karty' : 'Nikdo si zatím nic nevzal', w * 0.48), x + w - 18, y + 2);
  }
}

function title(g: CanvasRenderingContext2D, text: string, x: number, y: number) {
  g.textAlign = 'left';
  g.fillStyle = PURPLE;
  g.font = `900 26px ${FONT}`;
  g.fillText(text.toUpperCase(), x, y + 10);
}
