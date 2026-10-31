// Why the autopilot and the hand-out pass a card over, said once: a toast the first time a card is
// passed over for a reason, again only when the reason changes, never on every poll.

/** One card passed over, and why. */
export interface Skipped {
  id: string;
  name: string;
  why: string;
}

/** How many names one toast lists before it counts the rest. */
const NAMES = 3;

export class SkipNotice {
  private said = new Map<string, string>();

  constructor(private toast: (text: string) => void) {}

  /**
   * Says, for `who`, the cards passed over this round whose reason is new, one toast per reason.
   * `still` holds the cards `who` still looks at: what was said for any other is forgotten, so a card
   * that comes back and is passed over again is said again.
   */
  report(who: string, skipped: readonly Skipped[], still: ReadonlySet<string>) {
    for (const key of [...this.said.keys()]) if (key.startsWith(`${who}\n`) && !still.has(key.slice(who.length + 1))) this.said.delete(key);
    const fresh = new Map<string, string[]>();
    for (const s of skipped) {
      const key = `${who}\n${s.id}`;
      if (this.said.get(key) === s.why) continue;
      this.said.set(key, s.why);
      fresh.set(s.why, [...(fresh.get(s.why) ?? []), `“${s.name}”`]);
    }
    for (const [why, names] of fresh) {
      const more = names.length > NAMES ? ` and ${names.length - NAMES} more` : '';
      this.toast(`${who} passes over ${names.slice(0, NAMES).join(', ')}${more}: ${why}`);
    }
  }

  /** Whether `who` holds off for `why` (none: it doesn't), said the first time and again once it changed. */
  holds(who: string, why: string | undefined): boolean {
    const key = `${who}:hold`;
    if (!why) {
      this.said.delete(key);
      return false;
    }
    if (this.said.get(key) !== why) {
      this.said.set(key, why);
      this.toast(`${who} holds off: ${why}`);
    }
    return true;
  }

  /** Forgets what was said for a card, once `who` took it. */
  forget(who: string, id: string) {
    this.said.delete(`${who}\n${id}`);
  }
}
