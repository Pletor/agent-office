// The purple board's drawing pieces: its fonts and colours, panel titles, pills and how long ago.

export const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
export const INK = '#2b2d42';
export const PURPLE = '#9b5de5';
export const MUTED = '#868e96';
export const GREEN = '#38d9a9';

/** How long ago `at` was, shortly: 5 s, 3 min, 2 h. */
export function ago(at: string | number, now: number): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

/** A panel's title in capitals, purple. */
export function title(g: CanvasRenderingContext2D, text: string, x: number, y: number, size = 24) {
  g.textAlign = 'left';
  g.fillStyle = PURPLE;
  g.font = `900 ${size}px ${FONT}`;
  g.fillText(text.toUpperCase(), x, y + 10);
}

/** A rounded box, filled and outlined. */
export function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, line = 3) {
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = line;
    g.stroke();
  }
}

/** A pill with `text`, its left edge at `x`; returns its width. */
export function pill(g: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, bg: string, fg: string, stroke?: string): number {
  g.font = `900 ${Math.round(h * 0.5)}px ${FONT}`;
  const w = g.measureText(text).width + h * 0.8;
  box(g, x, y - h / 2, w, h, h / 2, bg, stroke, 2);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.fillText(text, x + w / 2, y + 1);
  return w;
}

/** A dot of a state's colour, outlined. */
export function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  g.fillStyle = fill;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}
