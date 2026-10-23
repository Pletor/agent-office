// "Design karta v procesu" on the purple board, for an orchestrator's card on the design pipeline: the
// seven stages on a rail with the current one working, "Jak to bude vypadat" (the sketch × screenshot
// before/after, its cut sweeping to and fro), the read-only mode Podle brandu / Nový směr, the project's
// DESIGN.md brand, the evidence slots and who's on turn. The same reading of the card as the ledge's
// detail window (orchestrator/design.ts, design-preview/stage.ts), drawn for the board; E opens it whole.

import type { OporaPreviewReply } from '../../../shared/opora-preview';
import type { OporaCard } from '../../../shared/protocol';
import { designStage, evidence, shownHead, type StageInput } from '../design-preview/stage';
import { NAMES, turnSentence, YIELDS } from '../orchestrator/design';
import type { Lane } from '../process-wall/lanes';
import { fit } from '../oporascope/screen';
import { box, FONT, GREEN, INK, MUTED, pill, PURPLE, title } from './paint';

const ACCENT = '#1d6b70';
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SLOT: Record<string, string> = { full: GREEN, human: ACCENT, half: '#c99a3a', none: '#ffffff' };

export interface StripInput {
  card: OporaCard;
  lane?: Lane;
  worker?: string;
  preview?: OporaPreviewReply;
  sketch?: HTMLImageElement;
  shot?: HTMLImageElement;
}

/** The strip in the rectangle (x, y, w, h); `now` moves the working stage and the before/after cut. */
export function paintDesign(g: CanvasRenderingContext2D, d: StripInput, x: number, y: number, w: number, h: number, now: number) {
  const r = d.preview;
  const input: StageInput = { status: d.card.status, stage: d.card.stage, phase: d.lane?.phase ?? 0, moved: !!d.lane && d.lane.marker !== 'none', branch: d.lane?.branch, pr: d.lane?.pr,
    working: !!d.lane?.working, preview: r?.state === 'ok' ? r : r ? { ...r, heads: [] } : undefined };
  const stage = designStage(input);
  const head = shownHead(r);
  const [sentence, tone] = turnSentence(stage, d.worker, !!head?.confirmed);
  box(g, x, y, w, h, 16, '#faf8f4', INK, 3);
  title(g, 'Design karta · jak to bude vypadat', x + 16, y + 18, 20);
  g.textAlign = 'right';
  g.fillStyle = MUTED;
  g.font = `800 17px ${FONT}`;
  g.fillText(r ? `${stage + 1}. ${NAMES[stage]} · E celá karta` : 'čtu náhled z Opory…', x + w - 16, y + 28);

  // The rail: seven stages, done ones green, the current one with its bead working.
  const ry = y + 50, rh = 64, gap = 6, sw = (w - 32 - gap * 6) / 7;
  for (let i = 0; i < 7; i++) {
    const sx = x + 16 + i * (sw + gap);
    const done = i < stage || stage === 6, cur = i === stage && stage !== 6;
    box(g, sx, ry, sw, rh, 10, cur ? '#e2efee' : '#ffffff', cur ? ACCENT : '#c4bcae', cur ? 3 : 2);
    g.textAlign = 'left';
    g.fillStyle = cur ? ACCENT : INK;
    g.font = `900 15px ${FONT}`;
    g.fillText(fit(g, `${i + 1}/7 ${NAMES[i]}`, sw - 14), sx + 8, ry + 17);
    g.fillStyle = MUTED;
    g.font = `700 13px ${FONT}`;
    g.fillText(fit(g, YIELDS[i], sw - 14), sx + 8, ry + 36);
    box(g, sx + 8, ry + rh - 15, sw - 16, 6, 3, '#efebe3');
    const k = done ? 1 : cur ? 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(now / 450)) : 0;
    if (k) box(g, sx + 8, ry + rh - 15, (sw - 16) * k, 6, 3, done ? '#3b6d3f' : ACCENT);
  }

  // Jak to bude vypadat: the sketch under, the screenshot from the cut on, the cut sweeping.
  const py = ry + rh + 14, ph = y + h - py - 14, pw = Math.min(380, w * 0.42);
  box(g, x + 16, py, pw, ph, 10, '#ffffff', '#c4bcae', 2);
  const before = d.sketch, after = d.shot;
  const fitImg = (img: HTMLImageElement) => {
    const s = Math.min((pw - 12) / img.width, (ph - 12) / img.height);
    const iw = img.width * s, ih = img.height * s;
    return [x + 16 + (pw - iw) / 2, py + (ph - ih) / 2, iw, ih] as const;
  };
  if (before || after) {
    const base = (before ?? after)!;
    const [ix, iy, iw, ih] = fitImg(base);
    g.drawImage(base, ix, iy, iw, ih);
    if (before && after) {
      const cut = 0.5 + 0.35 * Math.sin(now / 900);
      const [ax, ay, aw, ah] = fitImg(after);
      g.save();
      g.beginPath();
      g.rect(ix + iw * cut, iy, iw * (1 - cut) + 1, ih);
      g.clip();
      g.drawImage(after, ax, ay, aw, ah);
      g.restore();
      g.fillStyle = PURPLE;
      g.fillRect(ix + iw * cut - 2, iy, 4, ih);
      pill(g, r?.mode === 'explore' ? 'brand' : 'návrh', ix + 4, iy + 16, 24, INK, '#fffaf3');
      pill(g, r?.mode === 'explore' ? 'nový směr' : 'výsledek', ix + iw - 90, iy + 16, 24, PURPLE, '#fffaf3');
    }
  } else {
    g.textAlign = 'center';
    g.fillStyle = MUTED;
    g.font = `800 18px ${FONT}`;
    g.fillText(!r ? 'Čtu náhled…' : r.state !== 'ok' ? 'Náhled zatím není k dispozici' : 'Zatím bez skici a screenshotu', x + 16 + pw / 2, py + ph / 2);
  }

  // Beside it: the mode, the brand, the evidence and who's on turn.
  const sx = x + 32 + pw, sw2 = w - pw - 48;
  let cy = py + 14;
  const explore = r?.mode === 'explore';
  let mx = sx;
  mx += pill(g, 'Podle brandu', mx, cy, 28, !explore ? ACCENT : '#ffffff', !explore ? '#ffffff' : MUTED, '#c4bcae') + 6;
  pill(g, 'Nový směr', mx, cy, 28, explore ? ACCENT : '#ffffff', explore ? '#ffffff' : MUTED, '#c4bcae');
  cy += 34;
  const ds = r?.designSystem;
  g.textAlign = 'left';
  g.fillStyle = INK;
  g.font = `800 15px ${FONT}`;
  g.fillText(fit(g, ds?.available ? `DESIGN.md · rev ${ds.revision?.slice(0, 7) ?? '?'}${ds.brand?.fonts[0] ? ` · Aa ${ds.brand.fonts[0]}` : ''}` : 'DESIGN.md: projekt ho zatím nemá', sw2), sx, cy);
  let cx = sx;
  for (const c of (ds?.brand?.colors ?? []).filter((c) => HEX.test(c.hex)).slice(0, 8)) { box(g, cx, cy + 10, 22, 22, 5, c.hex, INK, 2); cx += 28; }
  cy += ds?.brand?.colors.length ? 46 : 22;
  for (const e of evidence(input, stage).slice(0, 5)) {
    box(g, sx, cy - 7, 14, 14, 3, SLOT[e.state] ?? '#fff', e.state === 'none' ? '#c4bcae' : INK, 2);
    g.fillStyle = e.state === 'none' ? MUTED : INK;
    g.font = `700 14px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(fit(g, `${e.name} · ${e.state === 'none' ? 'chybí' : e.note ?? 'doloženo'}`, sw2 - 24), sx + 22, cy);
    cy += 21;
  }
  const bg = tone === 'wait' ? '#f6ecd8' : tone === 'ok' ? '#e3f1e6' : '#e2efee';
  const fg = tone === 'wait' ? '#8a5f0f' : tone === 'ok' ? '#3b6d3f' : ACCENT;
  if (cy + 34 < y + h) {
    box(g, sx, cy, sw2, 32, 8, bg);
    g.fillStyle = fg;
    g.font = `800 15px ${FONT}`;
    g.fillText(fit(g, sentence, sw2 - 20), sx + 10, cy + 17);
  }
}
