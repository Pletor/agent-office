import type { HarnessBinding, HarnessLayer, HarnessProfile, HarnessScope } from '../../../../shared/harness-cascade';
import { h } from '../../../ui/dom';

/** Legacy profile slots only: seven-level installations retain their own hierarchy editor. */
export function slotControls(editor: HTMLTextAreaElement, changed: () => void) {
  const el = h('section.harness-slot-controls', { 'aria-label': 'Assignment switches' });
  let previousView: HarnessProfile | undefined, previousScope: HarnessScope | undefined;
  const lastBinding = new Map<string, HarnessBinding>();
  function render(view: HarnessProfile, scope: HarnessScope, writable: boolean) {
    if (previousView !== view || previousScope !== scope) { lastBinding.clear(); previousView = view; previousScope = scope; }
    let draft: HarnessLayer;
    try {
      draft = JSON.parse(editor.value);
      if (!draft || Array.isArray(draft) || typeof draft !== 'object' || Object.values(draft).some(binding => binding !== null &&
        (!binding || typeof binding !== 'object' || Object.keys(binding).length !== 1 || !('resource' in binding && typeof binding.resource === 'string' || 'value' in binding && ['string', 'number', 'boolean'].includes(typeof binding.value))))) throw new Error();
    }
    catch { el.replaceChildren(h('p', {}, 'Fix the layer JSON to use assignment switches.')); return; }
    const upstream: HarnessProfile['effective'] = {}, effective: HarnessProfile['effective'] = {};
    for (const level of ['global', 'repository', 'task'] as const) {
      if (level === scope) break;
      for (const [slot, binding] of Object.entries(view.layers[level])) upstream[slot] = effective[slot] = { binding, scope: level };
    }
    for (const [slot, binding] of Object.entries(draft)) effective[slot] = { binding, scope };
    for (const [slot, binding] of Object.entries(draft)) if (binding) lastBinding.set(slot, binding);
    const enabled = new Set(Object.values(effective).flatMap(item => item.binding && 'resource' in item.binding ? [item.binding.resource] : []));
    el.replaceChildren(h('h4', {}, 'Assignment switches'), h('p.harness-assignment-count', {}, `${enabled.size} enabled resources · ${Object.keys(effective).length} configured slots · separate from exported pack`),
      h('p.harness-muted', {}, 'These switches edit the selected layer. Save layer applies the draft to future preparation.'), ...Object.entries(effective).map(([slot, value]) => {
      const own = Object.hasOwn(draft, slot), binding = value.binding, inherited = lastBinding.get(slot) ?? upstream[slot]?.binding ?? view.layers[scope][slot];
      const boolean = binding && 'value' in binding && typeof binding.value === 'boolean';
      const canEnable = binding !== null || inherited != null;
      const checkbox = h('input', { type: 'checkbox', checked: boolean ? binding.value as boolean : binding !== null, disabled: !writable || !canEnable, 'aria-label': 'Enable ' + slot });
      checkbox.onchange = () => {
        draft[slot] = boolean ? { value: checkbox.checked } : checkbox.checked ? binding ?? inherited : null;
        editor.value = JSON.stringify(draft, null, 2); changed(); render(view, scope, writable);
      };
      const restore = h('button.btn', { type: 'button', disabled: !writable || !own, onclick: () => {
        delete draft[slot]; editor.value = JSON.stringify(draft, null, 2); changed(); render(view, scope, writable);
      } }, 'Inherit');
      const resource = binding && 'resource' in binding ? binding.resource : binding && 'value' in binding ? String(binding.value) : 'Disabled';
      return h('div.harness-slot-row', {}, h('label', {}, checkbox, h('span', {}, h('strong', {}, slot), h('small', {}, resource), h('small', {}, (own ? 'Explicit · ' : 'Inherited · ') + value.scope))), restore);
    }));
    if (!Object.keys(effective).length) el.append(h('p', {}, 'No assignments at this level. Choose a resource and Assign resource to add one.'));
  }
  return { el, render };
}
