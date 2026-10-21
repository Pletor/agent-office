// The editor's model without the DOM (docs/harness.md "Categories and the editor"): the slots of one
// level as the editor lists them, each inherited, own or disabled; the draft (unsaved edits) as a diff
// against the saved layer; and the rebase that keeps a draft on top of a newer revision after a conflict.
//
// Three things are kept apart on purpose:
//   - the saved profile: the layer as the store holds it at a revision (`base`),
//   - the draft: what the editor would save (`draft`), shown as "slot: from → to" until saved or discarded,
//   - the ad-hoc pack: the footer's "Add to pack" selection, exported and never saved (not modelled here).
import { HARNESS_LEVELS, resolveHarness, type HarnessBinding, type HarnessEffective, type HarnessLayer, type HarnessLevel, type HarnessPath } from '../../../shared/harness-cascade';
import type { HarnessResourceState } from '../../../shared/harness';
import { shortDigest } from '../../../shared/harness';

/** A slot name the store takes (profiles.ts parseHarnessLayer). */
export const SLOT_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
/** The most slots one layer may set. */
export const MAX_SLOTS = 64;

/** Why `name` can't be a slot, or nothing when it can. */
export function slotProblem(name: string): string | undefined {
  if (!SLOT_NAME.test(name) || RESERVED.includes(name)) return 'A slot name starts with a letter and has up to 80 letters, digits, ".", "_" or "-" (for example rules.quality).';
  return undefined;
}

/**
 * A slot's state at the edited level:
 *   own       the level sets it (an element or a value),
 *   disabled  the level sets it to null: nothing reaches the levels below, whatever is above,
 *   inherited the level doesn't name it: it gets what the levels above set,
 *   unset     nobody above sets it either (a slot the draft just reset with nothing to inherit).
 */
export type SlotState = 'own' | 'disabled' | 'inherited' | 'unset';
export interface SlotRow {
  slot: string;
  state: SlotState;
  /** The level's own binding in the draft (undefined: the level doesn't name it). */
  own: HarnessBinding | null | undefined;
  /** What the levels above give it. */
  inherited?: HarnessEffective;
  /** The draft differs from the saved layer for this slot. */
  changed: boolean;
}

export const sameBinding = (a: HarnessBinding | null | undefined, b: HarnessBinding | null | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** What the levels above `level` resolve to down `path`: what the level inherits. */
export function inheritedAt(layers: Partial<Record<HarnessLevel, HarnessLayer>>, path: HarnessPath, level: HarnessLevel): Record<string, HarnessEffective> {
  const above = HARNESS_LEVELS.slice(0, HARNESS_LEVELS.indexOf(level));
  return resolveHarness(Object.fromEntries(above.map((l) => [l, layers[l] ?? {}])), path);
}

/** The editor's rows: every slot the level inherits, sets, or the draft names, by name. */
export function slotRows(inherited: Record<string, HarnessEffective>, base: HarnessLayer, draft: HarnessLayer): SlotRow[] {
  const names = [...new Set([...Object.keys(inherited), ...Object.keys(base), ...Object.keys(draft)])].sort((a, b) => a.localeCompare(b));
  return names.map((slot) => {
    const own = slot in draft ? draft[slot] : undefined;
    const state: SlotState = own === null ? 'disabled' : own !== undefined ? 'own' : inherited[slot] ? 'inherited' : 'unset';
    return { slot, state, own, inherited: inherited[slot], changed: !sameBinding(slot in base ? base[slot] : undefined, own) };
  });
}

export interface SlotChange { slot: string; from: HarnessBinding | null | undefined; to: HarnessBinding | null | undefined }
/** What saving `next` over `base` changes, slot by slot (undefined: the level doesn't name the slot, it inherits). */
export function diffLayers(base: HarnessLayer, next: HarnessLayer): SlotChange[] {
  const names = [...new Set([...Object.keys(base), ...Object.keys(next)])].sort((a, b) => a.localeCompare(b));
  return names.flatMap((slot) => {
    const from = slot in base ? base[slot] : undefined, to = slot in next ? next[slot] : undefined;
    return sameBinding(from, to) ? [] : [{ slot, from, to }];
  });
}

/** The draft's edits (its diff from `oldBase`) applied on top of `server`: a conflict keeps what others saved in slots the draft never touched. */
export function rebase(oldBase: HarnessLayer, draft: HarnessLayer, server: HarnessLayer): HarnessLayer {
  const next: HarnessLayer = structuredClone(server);
  for (const { slot, to } of diffLayers(oldBase, draft)) {
    if (to === undefined) delete next[slot];
    else next[slot] = to;
  }
  return next;
}

/** A binding in words: what a reader sees in the slot list, the draft diff and the conflict notice. */
export function describeBinding(b: HarnessBinding | null | undefined, resources: Record<string, HarnessResourceState> = {}, titleOf?: (id: string) => string | undefined): string {
  if (b === undefined) return 'inherit';
  if (b === null) return 'disabled';
  if ('resource' in b) {
    const r = resources[b.resource];
    if (r?.status === 'available') return `${r.title} (revision ${r.version} · ${shortDigest(r.digest)})`;
    if (r?.status === 'missing') return `${r.title || b.resource} (unavailable: ${r.missingSince ? 'missing since ' + r.missingSince.slice(0, 10) : 'not published in this project'})`;
    if (r?.status === 'unknown') return `${b.resource} (unknown element)`;
    return titleOf?.(b.resource) ?? b.resource;
  }
  return JSON.stringify(b.value);
}

/** A scalar setting typed the way its slot already holds it, or why the text isn't one. */
export function parseSetting(text: string, kind: 'string' | 'number' | 'boolean'): { value: string | number | boolean } | { error: string } {
  if (kind === 'number') {
    const n = Number(text.trim());
    return text.trim() && Number.isFinite(n) ? { value: n } : { error: 'Enter a number (for example 3 or 0.5).' };
  }
  if (kind === 'boolean') {
    const t = text.trim().toLowerCase();
    return t === 'true' || t === 'false' ? { value: t === 'true' } : { error: 'Enter true or false.' };
  }
  return text.length <= 4000 ? { value: text } : { error: 'A text setting is at most 4,000 characters.' };
}
/** The kind of scalar a binding holds, for its editor (text when it holds none). */
export const settingKind = (b: HarnessBinding | null | undefined): 'string' | 'number' | 'boolean' =>
  b && 'value' in b ? (typeof b.value === 'number' ? 'number' : typeof b.value === 'boolean' ? 'boolean' : 'string') : 'string';

/** A layer typed by hand in "Advanced: JSON", checked the way the store checks it, or why it isn't one. */
export function parseLayerText(text: string): { layer: HarnessLayer } | { error: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch (err) { return { error: 'The layer is not valid JSON: ' + (err as Error).message }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'A layer is a JSON object of slots.' };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SLOTS) return { error: `A layer sets at most ${MAX_SLOTS} slots.` };
  for (const [slot, b] of entries) {
    const bad = slotProblem(slot);
    if (bad) return { error: `"${slot.slice(0, 80)}": ${bad}` };
    if (b === null) continue;
    const ok = !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 1 && (
      (typeof (b as { resource?: unknown }).resource === 'string' && ((b as { resource: string }).resource.length > 0 && (b as { resource: string }).resource.length <= 100))
      || ['boolean', 'number', 'string'].includes(typeof (b as { value?: unknown }).value));
    if (!ok) return { error: `"${slot}": each slot is {"resource": "<element id>"}, {"value": text, number or true/false}, or null.` };
  }
  return { layer: value as HarnessLayer };
}

/** Where an element is assigned along the loaded path: one line per level that names it, `Global · rules.start`. */
export function usageOf(id: string, layers: Partial<Record<HarnessLevel, HarnessLayer>>, levelName: (level: HarnessLevel) => string): string[] {
  return HARNESS_LEVELS.flatMap((level) => Object.entries(layers[level] ?? {}).filter(([, b]) => b && 'resource' in b && b.resource === id).map(([slot]) => levelName(level) + ' · ' + slot));
}
