const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const shown = (e: HTMLElement) => (e.checkVisibility ? e.checkVisibility() : e.offsetParent !== null);

/**
 * The library's keyboard, while it's the window on top: Tab and Shift+Tab stay inside it, ↑/↓/Home/End
 * walk the resource list, / jumps to the search. `release` puts focus back where it was before opening.
 */
export function libraryKeys(el: HTMLElement, search: HTMLInputElement, list: HTMLElement) {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const onTop = () => el.parentElement !== null && el.parentElement === el.parentElement.parentElement?.lastElementChild;
  const onKey = (e: KeyboardEvent) => {
    if (!onTop() || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target instanceof HTMLElement ? e.target : undefined;
    if (e.key === 'Tab') {
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
      if (!items.length) return;
      const at = target && el.contains(target) ? items.indexOf(target) : -1;
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
      e.preventDefault();
      items[next].focus();
      return;
    }
    if (e.key === '/' && !target?.closest('input, textarea, select')) {
      e.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (!target?.matches('.harness-entry') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const entries = [...list.querySelectorAll<HTMLElement>('.harness-entry')];
    const at = entries.indexOf(target);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? entries.length - 1 : Math.min(entries.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    entries[next]?.focus();
  };
  window.addEventListener('keydown', onKey, true);
  return {
    release() {
      window.removeEventListener('keydown', onKey, true);
      if (before?.isConnected && before !== document.body) before.focus({ preventScroll: true });
    },
  };
}
