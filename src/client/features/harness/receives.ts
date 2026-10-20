// "What the worker receives" (docs/harness.md "Choosing the context"): the resolved slots of the chosen
// context, each with the level and the node it came from, and the digest of the handoff snapshot a
// worker would get. It is a preview of the result, kept apart from "This level's own settings" (the
// editor), never mixed into it: the editor shows one level, this shows what all of them add up to.
import { h } from '../../ui/dom';
import { resolveHarness, type HarnessProfile } from '../../../shared/harness-cascade';
import { levelName, type HarnessContext } from './context-model';

/** The profile reply the panel reads (GET /api/harness/profile). */
export type ReceivedView = HarnessProfile & { preview: string; warning: string };

/** The snapshot digest of a handoff preview (harness/handoff.ts writes it as `Snapshot SHA-256: <hex>`). */
export function previewDigest(preview: string): string | undefined {
  return /Snapshot SHA-256: ([0-9a-f]{64})/.exec(preview)?.[1];
}

export function receivesPanel() {
  const heading = h('h3', {}, 'What the worker receives');
  const about = h('p.harness-receives-about');
  const digest = h('p.harness-digest');
  const table = h('table.harness-effective-table.harness-receives-table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Slot'), h('th', {}, 'Value'), h('th', {}, 'From level'), h('th', {}, 'From node'))), h('tbody'));
  const preview = h('pre.harness-effective');
  const full = h('details', {}, h('summary', {}, 'Full handoff preview'), preview);
  const summary = h('summary', {}, 'What the worker receives');
  const el = h('details.harness-receives', {}, summary, heading, about, digest, table, full);
  const body = table.querySelector('tbody')!;

  function message(text: string) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '4' }, text)));
  }
  return {
    el,
    /** Nothing to show yet: the profile of `label` is loading, or failed with `text`. */
    pending(label: string, text = 'Loading…') {
      summary.textContent = 'What the worker receives · ' + label.split(' › ').pop();
      about.textContent = '';
      digest.textContent = '';
      preview.textContent = '';
      full.hidden = true;
      message(text);
    },
    show(view: ReceivedView, ctx: HarnessContext, label: string, projectName: string) {
      summary.textContent = 'What the worker receives · ' + label.split(' › ').pop();
      const global = ctx.kind === 'global';
      // Global alone is what every project starts from; the floor's own layers aren't part of it.
      const effective = global ? resolveHarness({ global: view.layers.global }) : view.effective;
      about.textContent = global
        ? 'Global is where every project starts. Choose a project to see what its workers receive.'
        : 'Resolved down Global → ' + label.replaceAll(' › ', ' → ') + '. A slot comes from the deepest level that sets it.';
      const names = new Map(view.path.map((p) => [p.node, p.name ?? '']));
      const from = (e: HarnessProfile['effective'][string]) => e.scope === 'global' ? 'Global' : e.scope === 'project' ? projectName : (e.nodeName || (e.node && names.get(e.node)) || e.node || '—');
      const rows = Object.entries(effective).map(([slot, e]) => h('tr', {}, h('td', {}, slot),
        h('td', {}, e.binding === null ? 'null (disabled)' : 'resource' in e.binding ? 'resource ' + e.binding.resource : JSON.stringify(e.binding.value)),
        h('td', {}, levelName(e.scope)), h('td', { title: e.node ?? '' }, from(e))));
      if (rows.length) body.replaceChildren(...rows);
      else message(global ? 'Global sets no slots.' : 'No slots are set at any level.');
      const sha = global ? undefined : previewDigest(view.preview);
      digest.textContent = global ? '' : sha ? 'Manifest digest (snapshot SHA-256): ' + sha + (view.warning ? ' · ' + view.warning : '') : 'Handoff blocked: ' + (view.warning || 'no snapshot.');
      preview.textContent = global ? '' : view.preview || view.warning;
      full.hidden = global;
    },
  };
}
