// Switching the library's context (docs/harness.md "Choosing the context"): the bar asks, the switcher
// decides. A switch with no unsaved edits happens at once; one that would lose edits in "This level's
// own settings" asks first (the bar's guard): discard and switch, or keep editing (the bar goes back to
// the context still shown). Every switch is remembered for the page's lifetime (closing and reopening
// the library comes back to it) and handed to the editor, whose loads drop any reply of the context
// before (cascade.ts).
import { contextFloor, normalizeContext, rememberContext, sameContext, type HarnessContext } from './context-model';

interface Bar { set(ctx: HarnessContext): void; guard(text: string, onDiscard: () => void, onKeep: () => void): void; label(ctx: HarnessContext): string }
interface Editor { dirty(): boolean; discard(): void; show(ctx: HarnessContext): void }
interface Preview { pending(label: string): void }

export function contextSwitcher(opts: { opened: string; initial: HarnessContext; bar: () => Bar; editor: () => Editor; preview: () => Preview; onApplied(ctx: HarnessContext, floorChanged: boolean): void }) {
  let context = normalizeContext(opts.initial, opts.opened);
  function apply(next: HarnessContext) {
    const floor = contextFloor(context, opts.opened);
    context = normalizeContext(next, opts.opened);
    rememberContext(context);
    opts.bar().set(context);
    opts.preview().pending(opts.bar().label(context));
    opts.editor().show(context);
    opts.onApplied(context, contextFloor(context, opts.opened) !== floor);
  }
  return {
    get: () => context,
    /** Shows the context it starts in. */
    start() { apply(context); },
    /** The bar asks for `next`. */
    request(next: HarnessContext) {
      const was = context;
      if (sameContext(next, was)) return opts.bar().set(was);
      if (!opts.editor().dirty()) return apply(next);
      opts.bar().guard(`Unsaved changes to ${opts.bar().label(was)} would be lost.`, () => { opts.editor().discard(); apply(next); }, () => opts.bar().set(was));
    },
  };
}
