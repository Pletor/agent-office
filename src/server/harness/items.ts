import path from 'node:path';
import type { HarnessCategory, HarnessEntry, HarnessItem, HarnessItemView, HarnessText } from '../../shared/harness.js';

/** A definition file sits next to what it defines: `.harness/hooks/typecheck.item.json`, `.harness/skills/x/x.item.json`. */
export const isItemPath = (file: string) => /\.item\.json$/i.test(file);

const KINDS: Record<HarnessItem['kind'], HarnessCategory> = { skill: 'skills', hook: 'hooks', script: 'scripts', command: 'commands' };
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'SubagentStop']);
const ROLES = new Set(['instructions', 'reference', 'script', 'example', 'asset']);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max && !/[\0\r]/.test(value);
const relative = (value: unknown) => typeof value === 'string' && value.length <= 240 && !/[\\\0-\x1f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Parse and check a `harness.item/1` definition exactly; anything unknown or loose is refused, never guessed. */
export function parseItem(source: string, category: HarnessCategory): HarnessItem {
  let value: Record<string, unknown>;
  try { value = JSON.parse(source); } catch { throw new Error('Definice není platný JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Definice musí být objekt.');
  const allowed = new Set(['schema', 'kind', 'name', 'summary', 'when', 'trigger', 'run', 'parts', 'deterministic', 'outputs', 'verify']);
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (extra.length) throw new Error('Neznámá pole definice: ' + extra.join(', '));
  if (value.schema !== 'harness.item/1') throw new Error('Definice musí mít schema harness.item/1.');
  const kind = value.kind as HarnessItem['kind'];
  if (!Object.hasOwn(KINDS, kind)) throw new Error('kind je skill, hook, script nebo command.');
  if (KINDS[kind] !== category) throw new Error(`Definice druhu ${kind} patří do složky ${KINDS[kind]}.`);
  if (typeof value.name !== 'string' || !NAME.test(value.name)) throw new Error('name: malá písmena, číslice a pomlčky, nejvýše 64 znaků.');
  for (const key of ['summary', 'when', 'outputs', 'verify'] as const) if (value[key] !== undefined && !text(value[key], 500)) throw new Error(key + ': text do 500 znaků.');
  if (!text(value.summary, 500)) throw new Error('summary je povinné.');
  if (typeof value.deterministic !== 'boolean') throw new Error('deterministic je true, nebo false.');
  let trigger: HarnessItem['trigger'];
  if (value.trigger !== undefined) {
    const t = value.trigger as Record<string, unknown>;
    if (!t || typeof t !== 'object' || Object.keys(t).some(key => key !== 'event' && key !== 'matcher') || !EVENTS.has(t.event as string)
      || (t.matcher !== undefined && !text(t.matcher, 200))) throw new Error('trigger: { event, matcher? } s událostí runneru.');
    trigger = { event: t.event as string, ...(t.matcher !== undefined ? { matcher: t.matcher as string } : {}) };
  }
  if (kind === 'hook' && !trigger) throw new Error('Hook potřebuje trigger.');
  if (kind !== 'hook' && trigger) throw new Error('trigger má jen hook.');
  let run: HarnessItem['run'];
  if (value.run !== undefined) {
    const r = value.run as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Object.keys(r).some(key => !['runner', 'entry', 'args'].includes(key)) || r.runner !== 'node' || !relative(r.entry)
      || (r.args !== undefined && (!Array.isArray(r.args) || r.args.length > 16 || !r.args.every(arg => text(arg, 200))))) throw new Error('run: { runner: "node", entry, args? }.');
    run = { runner: 'node', entry: r.entry as string, args: (r.args as string[] | undefined) ?? [] };
  }
  if ((kind === 'hook' || kind === 'script') && !run) throw new Error(kind + ' potřebuje run: co se deterministicky spustí.');
  if (!Array.isArray(value.parts) || value.parts.length > 16) throw new Error('parts: seznam nejvýše 16 částí.');
  const seen = new Set<string>();
  const parts = value.parts.map((item: unknown) => {
    const p = item as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Object.keys(p).some(key => key !== 'path' && key !== 'role') || !relative(p.path) || !ROLES.has(p.role as string)) throw new Error('Část: { path, role } s rolí instructions, reference, script, example nebo asset.');
    if (seen.has(p.path as string)) throw new Error('Část je uvedená dvakrát: ' + p.path);
    seen.add(p.path as string);
    return { path: p.path as string, role: p.role as HarnessItem['parts'][number]['role'] };
  });
  if (run && !parts.some(part => part.path === run!.entry && part.role === 'script')) throw new Error('run.entry musí být mezi částmi jako script.');
  if (kind === 'skill' && !parts.some(part => part.role === 'instructions')) throw new Error('Skill potřebuje část instructions (SKILL.md).');
  return { schema: 'harness.item/1', kind, name: value.name, summary: value.summary as string, deterministic: value.deterministic,
    ...(value.when !== undefined ? { when: value.when as string } : {}), ...(trigger ? { trigger } : {}), ...(run ? { run } : {}), parts,
    ...(value.outputs !== undefined ? { outputs: value.outputs as string } : {}), ...(value.verify !== undefined ? { verify: value.verify as string } : {}) };
}

/** The catalog entries a definition's parts name: paths are relative to the definition's own source, so a part never reaches another source. */
export function itemParts(item: HarnessItem, definition: HarnessEntry, entries: HarnessEntry[]) {
  return item.parts.map(part => {
    const entry = entries.find(candidate => candidate.source === definition.source && candidate.path === path.posix.normalize(part.path));
    if (!entry) throw new Error(`Část ${part.path} definice ${definition.path} v knihovně není.`);
    return { ...part, entry };
  });
}

/** What the reader shows for a definition: the parsed definition with its parts, or exactly why it is refused. */
export function itemView(entry: HarnessText, entries: HarnessEntry[]): HarnessItemView {
  try {
    const definition = parseItem(entry.text, entry.category);
    return { definition, parts: itemParts(definition, entry, entries).map(({ path: file, role, entry: part }) => ({ path: file, role, id: part.id, title: part.title, category: part.category })) };
  } catch (err) { return { error: (err as Error).message }; }
}
