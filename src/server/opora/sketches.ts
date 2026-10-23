// What a person sketched for a card on Opora, as far as the bridge looks before it seats a worker:
// the card's own drawing (its layer in Opora's Kreslení mode, an Excalidraw scene) and its
// storyboard (moments, the person's comments and arrows, a sketch per moment, maybe code or a web
// scene as the animation). Two quick GETs; the worker reads the rest itself, through the skill.
import type { OporaClient } from './client.js';

/** What the bridge found on a card. Nothing found is undefined, not an empty one. */
export interface CardSketches {
  /** Elements in the card's own drawing layer, and how many of them are pasted images. */
  drawing: { elements: number; images: number };
  storyboard?: { animation: string; moments: number; open: number; sketches: number };
}

/** The Opora pages that show a card's drawing (Kreslení) and its storyboard, for a browser on the office's machine. */
export function oporaCardViews(base: string, project: string, workspace: string, node: string): { drawing: string; storyboard: string } {
  const at = (mode: string, extra: Record<string, string>) => {
    const url = new URL('/', base || 'http://127.0.0.1:8740');
    for (const [k, v] of Object.entries({ project, workspace, screen: 'canvas', environment: 'editor', mode, ...extra })) url.searchParams.set(k, v);
    return url.toString();
  };
  return { drawing: at('drawing', { layer: node }), storyboard: at('storyboard', { node }) };
}

/** Reads the card's drawing and storyboard. A read that fails counts as nothing there: the brief tells the worker to look anyway. */
export async function readSketches(client: OporaClient, project: string, workspace: string, node: string): Promise<CardSketches | undefined> {
  const [drawing, storyboard] = await Promise.all([client.drawing(project, workspace, node).catch(() => undefined), client.storyboard(project, workspace, node).catch(() => null)]);
  const elements = drawing?.elements ?? [];
  const moments = Array.isArray(storyboard?.moments) ? (storyboard.moments as Record<string, unknown>[]) : [];
  if (!elements.length && !storyboard) return undefined;
  return {
    drawing: { elements: elements.length, images: elements.filter((e) => e.type === 'image').length },
    ...(storyboard
      ? {
          storyboard: {
            animation: typeof storyboard.animation === 'string' ? storyboard.animation : '',
            moments: moments.length,
            open: moments.filter((m) => m && m.answered !== true && (m.comment || (Array.isArray(m.annotations) && m.annotations.length) || m.sketch)).length,
            sketches: moments.filter((m) => m && m.sketch).length,
          },
        }
      : {}),
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One sentence on what's there, for a brief. */
export function describeSketches(s: CardSketches | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.drawing.elements) parts.push(`a drawing of ${plural(s.drawing.elements, 'element')}${s.drawing.images ? ` (${plural(s.drawing.images, 'pasted image')})` : ''} in the card's own Kreslení layer`);
  const sb = s.storyboard;
  if (sb) parts.push(`a storyboard${sb.animation ? ` (animation "${sb.animation}")` : ''} with ${plural(sb.moments, 'moment')}${sb.sketches ? `, ${sb.sketches} sketched` : ''}${sb.open ? `, ${sb.open} waiting on a reply to the person's comment, arrow or sketch` : ''}`);
  return parts.length ? `On Opora this card has ${parts.join(' and ')}.` : '';
}
