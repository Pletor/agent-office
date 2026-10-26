import type { HarnessItemView } from '../../../../shared/harness';
import { h } from '../../../ui/dom';
import { categoryName } from './names';

const KIND: Record<string, string> = { skill: 'Skill pro LLM', hook: 'Hook', script: 'Deterministický skript', command: 'Příkaz' };
const ROLE: Record<string, string> = { instructions: 'Návod', reference: 'Reference', script: 'Skript', example: 'Příklad', asset: 'Podklad' };
const EVENT: Record<string, string> = { SessionStart: 'při startu relace', UserPromptSubmit: 'při každém zadání', PreToolUse: 'před nástrojem', PostToolUse: 'po nástroji',
  PreCompact: 'před shrnutím relace', Stop: 'na konci odpovědi', SubagentStop: 'na konci subagenta' };
export const isDefinition = (path: string) => /\.item\.json$/i.test(path);

/** A definition as a person reads it: what it is, when it runs, what runs, what it is made of and how it is checked. */
export function itemBlock(view: HarnessItemView, open: (id: string) => void) {
  if ('error' in view) return h('p.harness-pack-error', { role: 'alert' }, 'Definice je neplatná: ' + view.error);
  const item = view.definition;
  const row = (label: string, value: Node | string) => [h('dt', {}, label), h('dd', {}, value)];
  return h('section.harness-item', { 'aria-label': 'Definice' },
    h('h5', {}, h('span.harness-pill', { 'data-tone': item.deterministic ? 'ok' : 'wait' }, item.deterministic ? 'Deterministické' : 'Úsudek modelu'), ' ', KIND[item.kind], ' · ', item.name),
    h('p', {}, item.summary),
    h('dl.harness-box-facts', {},
      ...(item.when ? row('Kdy', item.when) : []),
      ...(item.trigger ? row('Spouštěč', (EVENT[item.trigger.event] ?? item.trigger.event) + (item.trigger.matcher ? ' · ' + item.trigger.matcher : '') + ' (' + item.trigger.event + ')') : []),
      ...(item.run ? row('Spustí', h('code.harness-box-command', {}, ['node', item.run.entry, ...item.run.args].join(' '))) : []),
      ...(item.outputs ? row('Výstup', item.outputs) : []),
      ...(item.verify ? row('Ověření', item.verify) : [])),
    h('h5', {}, `Z čeho se skládá · ${view.parts.length} částí, v balíčku pojedou s ní`),
    h('ul.harness-item-parts', {}, ...view.parts.map(part => h('li', {},
      h('span.harness-pill', {}, ROLE[part.role] ?? part.role), ' ',
      h('button.harness-item-part', { type: 'button', onclick: () => open(part.id) }, part.title), h('small', {}, ' ' + categoryName(part.category) + ' · ' + part.path)))));
}
