// Canvas helpers for the wall texture: the design's colours, its font, and shapes.

export const C = {
  bg: '#0f1320', bg2: '#181d2e', bg3: '#262b3d', line: '#2c3348', past: '#59627c',
  ink: '#f6f1e7', dim: '#b9c0d0', ok: '#06d6a0', warn: '#ffd166', bad: '#ef476f', info: '#5bc0eb', pink: '#ff8fa8',
} as const;

const FONT = 'Nunito, ui-rounded, "SF Pro Rounded", system-ui, sans-serif';

export type G = CanvasRenderingContext2D;

export function font(g: G, size: number, weight = 900) {
  g.font = `${weight} ${size}px ${FONT}`;
}

/** Cuts text to fit `width`, with an ellipsis. */
export function fit(g: G, text: string, width: number): string {
  if (g.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + '…').width > width) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

/** Draws text (left/middle by default) and returns its width. */
export function text(g: G, s: string, x: number, y: number, size: number, color: string, weight = 900, align: CanvasTextAlign = 'left'): number {
  font(g, size, weight);
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
  return g.measureText(s).width;
}

export function rrect(g: G, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export function dot(g: G, x: number, y: number, r: number, color: string) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
}

export function ring(g: G, x: number, y: number, r: number, color: string, width: number, dash?: number[]) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.setLineDash(dash ?? []);
  g.stroke();
  g.setLineDash([]);
}

/** A chip: rounded box with text in it; returns its width. */
export function chip(g: G, s: string, x: number, y: number, size: number, fg: string, bg: string, padX = 10, h = size + 8, r = 8): number {
  font(g, size);
  const w = g.measureText(s).width + padX * 2;
  rrect(g, x, y - h / 2, w, h, r);
  g.fillStyle = bg;
  g.fill();
  text(g, s, x + padX, y + 1, size, fg);
  return w;
}

/** A trail dot (20 px): confirmed, failed (a diamond), waiting (ring), seen, or skipped (dashed). */
export function trailDot(g: G, x: number, y: number, mark: 'ok' | 'fail' | 'wait' | 'seen' | 'skip', alpha = 1) {
  g.save();
  g.globalAlpha *= alpha;
  if (mark === 'ok') dot(g, x, y, 10, C.ok);
  else if (mark === 'seen') dot(g, x, y, 10, C.info);
  else if (mark === 'fail') {
    g.translate(x, y); g.rotate(Math.PI / 4);
    rrect(g, -9, -9, 18, 18, 3); g.fillStyle = C.bad; g.fill();
  } else if (mark === 'wait') { dot(g, x, y, 10, C.bg); ring(g, x, y, 8, C.warn, 4); }
  else { dot(g, x, y, 10, C.bg); ring(g, x, y, 8.5, C.past, 3, [4, 3]); }
  g.restore();
}
