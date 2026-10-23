// What the purple board reads for the orchestrator's card, beyond the floor's Opora state: what's
// inside the page on the canvas (GET /api/opora-layers: areas, sectors, nodes, the page's settings) and,
// for a design card, its preview (GET /api/opora-preview), with the sketch and the main screenshot as
// images for the board's before/after. Read again every 30 s while the card stays, never from Opora
// directly. And the room's own happenings for the board's feed: the card arriving, what people did here.

import { previewFileUrl, type OporaPreviewReply, type PreviewShot } from '../../../shared/opora-preview';
import type { OporaLayersReply } from '../../../shared/opora-layers';
import { shownHead } from '../design-preview/stage';

const EVERY_MS = 30_000;

/** A shot to compare: the one a person would look at first (phone, light), else the first. */
export function mainShot(shots: readonly PreviewShot[]): PreviewShot | undefined {
  return shots.find((s) => /mobil|phone|390/i.test(s.label) && !/tmav|dark/i.test(s.label)) ?? shots[0];
}

export class CardReads {
  layers?: OporaLayersReply;
  preview?: OporaPreviewReply;
  /** The sketch and the main screenshot of the shown head, once loaded. */
  sketch?: HTMLImageElement;
  shot?: HTMLImageElement;
  private card?: string;
  private at = 0;
  /** The card was read as a design card (its preview too). */
  private design = false;
  private ctl?: AbortController;

  constructor(private changed: () => void) {}

  /** The card to read for (or none); reads when it's new or the last read is older than 30 s. */
  follow(floor: string | null, card: string | undefined, design: boolean, now = Date.now()) {
    if (card !== this.card) {
      this.ctl?.abort();
      this.card = card;
      this.layers = this.preview = this.sketch = this.shot = undefined;
      this.at = 0;
    }
    // A card that turned out to be a design card (or became one) gets its preview at once.
    if (design && !this.design) this.at = 0;
    this.design = design;
    if (!floor || !card || now - this.at < EVERY_MS) return;
    this.at = now;
    const ctl = (this.ctl = new AbortController());
    const get = <T>(path: string, q: Record<string, string>) =>
      fetch(`${path}?${new URLSearchParams(q)}`, { signal: ctl.signal, cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))));
    get<OporaLayersReply>('/api/opora-layers', { floor, node: card }).then((r) => { if (this.card === card) { this.layers = r; this.changed(); } }, () => undefined);
    if (!design) return;
    get<OporaPreviewReply>('/api/opora-preview', { floor, card }).then((r) => {
      if (this.card !== card) return;
      this.preview = r;
      const shot = mainShot(shownHead(r)?.shots ?? []);
      if (r.sketch) this.image(previewFileUrl(floor, card, 'sketch'), (i) => (this.sketch = i), card);
      if (shot) this.image(previewFileUrl(floor, card, 'shot', shot.file), (i) => (this.shot = i), card);
      this.changed();
    }, () => undefined);
  }

  private image(src: string, keep: (i: HTMLImageElement) => void, card: string) {
    const i = new Image();
    i.decoding = 'async';
    i.onload = () => { if (this.card === card) { keep(i); this.changed(); } };
    i.src = src;
  }
}

/** Something that happened in the room, for the board's feed next to what the agents did on the canvas. */
export interface RoomNote { at: number; who: string; what: string }

/** The room's own notes, newest first, at most 8. */
export class RoomNotes {
  readonly list: RoomNote[] = [];
  add(who: string, what: string, at = Date.now()) {
    this.list.unshift({ at, who, what });
    this.list.length = Math.min(this.list.length, 8);
  }
}
