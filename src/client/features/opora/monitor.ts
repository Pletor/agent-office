/**
 * The boss's PC is the Opora workstation: while nobody's playing Minesweeper on its monitor, a card
 * over the game says so, and that O from the boss's chair opens Opora on the whole screen.
 */
import type { OporaState } from '../../../shared/protocol';

const FONT = "Nunito, ui-rounded, 'SF Pro Rounded', system-ui, sans-serif";

/** Paints the card on the monitor's 960×540 picture (see Arcade.setOverlay). */
export function paintOporaCard(g: CanvasRenderingContext2D, s: Pick<OporaState, 'connected' | 'project'>) {
  const w = 620;
  const hgt = 112;
  const x = (960 - w) / 2;
  // Under Minesweeper's title band (150–380), so both read.
  const y = 540 - hgt - 16;
  g.save();
  g.fillStyle = 'rgba(12, 18, 32, 0.9)';
  g.strokeStyle = s.connected ? '#7cc4ff' : '#8a93a6';
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(x, y, w, hgt, 18);
  g.fill();
  g.stroke();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.font = `bold 34px ${FONT}`;
  g.fillText(s.project ? `🛰️ Opora · ${s.project.name}`.slice(0, 34) : '🛰️ Opora', 480, y + 38);
  g.font = `24px ${FONT}`;
  g.fillStyle = s.connected ? '#cfe8ff' : '#c0c6d2';
  g.fillText(s.connected ? 'Sit down and press O for the whole screen' : 'Opora isn’t running · O opens its window', 480, y + 82);
  g.restore();
}
