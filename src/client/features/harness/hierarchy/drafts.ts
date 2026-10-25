import type { HarnessLayer, HarnessLevel } from '../../../../shared/harness-cascade';

/** An unsaved equipment draft left behind when the library closed, with the revision it was edited on. */
export interface KeptDraft { floor: string; level: HarnessLevel; target: string; revision: number; pathDigest: string; layer: HarnessLayer }

// Client memory only: closing by ✕ or Esc keeps the draft for this page load, never in storage or on the server.
const kept = new Map<string, KeptDraft>();
const key = (floor: string, level: HarnessLevel, target: string) => JSON.stringify([floor, level, target]);

/** Keeps the draft for its floor + level + target; the newest kept draft of a floor is the one reopened first. */
export function keepDraft(draft: KeptDraft) {
  const id = key(draft.floor, draft.level, draft.target);
  kept.delete(id); kept.set(id, { ...draft, layer: { ...draft.layer } });
}
/** Hands the kept draft of this scope back once; it is gone from memory afterwards. */
export function takeDraft(floor: string, level: HarnessLevel, target: string): KeptDraft | undefined {
  const id = key(floor, level, target), draft = kept.get(id);
  kept.delete(id); return draft;
}
/** The scope of the newest kept draft on this floor, so reopening the library lands on it. */
export function latestDraft(floor: string): Pick<KeptDraft, 'level' | 'target'> | undefined {
  let latest: KeptDraft | undefined;
  for (const draft of kept.values()) if (draft.floor === floor) latest = draft;
  return latest && { level: latest.level, target: latest.target };
}
