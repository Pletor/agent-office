// "Bind this floor" (docs/harness.md "Choosing the context"): for an administrator looking at an unbound
// project, the project and workspace the floor's Opora window reads now are offered for binding, with an
// explicit confirmation, through the existing POST /api/harness/binding. Nothing is guessed: no window
// project, no offer; the server checks again (binding-api.ts) that the window still reads exactly that.
import { h } from '../../ui/dom';

export interface WindowPlace { project: string; workspace: string; projectName: string }

export function bindFloorAction(opts: { floor: string; floorName: string; window: WindowPlace; signal: AbortSignal; onBound(): void }) {
  const w = opts.window;
  const offer = h('button.btn', { type: 'button' }, `Bind this floor to Opora ${w.projectName}`);
  const question = h('p', {}, `Bind floor ${opts.floorName} to Opora project ${w.projectName} (${w.project}), workspace ${w.workspace}? The floor's profiles below the project, its specializations and its card handoffs then belong to that project. A binding is changed only by an explicit rebind.`);
  const yes = h('button.btn.primary', { type: 'button' }, 'Bind floor');
  const no = h('button.btn', { type: 'button' }, 'Cancel');
  const status = h('p.harness-field-error', { role: 'status' });
  const confirm = h('div.harness-bind-confirm', { role: 'alertdialog', 'aria-label': 'Confirm binding', hidden: '' }, question, h('div.harness-actions', {}, yes, no));
  const el = h('div.harness-bind', {}, offer, confirm, status);
  offer.onclick = () => { confirm.hidden = false; offer.hidden = true; yes.focus?.(); };
  no.onclick = () => { confirm.hidden = true; offer.hidden = false; status.textContent = ''; offer.focus?.(); };
  yes.onclick = async () => {
    yes.disabled = no.disabled = true;
    status.textContent = 'Binding…';
    try {
      const response = await fetch('/api/harness/binding?' + new URLSearchParams({ floor: opts.floor }), {
        method: 'POST', signal: opts.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: w.project, workspace: w.workspace }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'The floor could not be bound.');
      status.textContent = `Bound to ${w.projectName}.`;
      confirm.hidden = true;
      opts.onBound();
    } catch (err) {
      if (opts.signal.aborted) return;
      status.textContent = 'Not bound: ' + (err as Error).message;
    } finally { yes.disabled = no.disabled = false; }
  };
  return el;
}
