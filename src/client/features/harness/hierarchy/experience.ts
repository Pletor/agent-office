import { h } from '../../../ui/dom';
import type { HarnessHierarchyView } from '../../../../shared/harness-navigation';

interface Rate { pass: number; fail: number; unknown: number; interval95: [number, number] | null }
interface Experience { id: string; digest: string; verified: Rate | null; reported: Rate | null; tasks: number; missing: string[] }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function rate(value: unknown): value is Rate | null {
  return value === null || object(value) && [value.pass, value.fail, value.unknown].every(count)
    && (value.interval95 === null || Array.isArray(value.interval95) && value.interval95.length === 2
      && value.interval95.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100));
}
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });
function line(title: string, value: Rate | null) {
  if (!value || !(value.pass + value.fail)) return title + ': nezjištěno' + (value?.unknown ? ` · ${value.unknown} neznámých` : '');
  const n = value.pass + value.fail, interval = value.interval95;
  return `${title}: ${number.format(100 * value.pass / n)} % · ${value.pass}/${n}`
    + (interval ? ` · 95% interval ${number.format(interval[0])}–${number.format(interval[1])} %` : '')
    + (value.unknown ? ` · ${value.unknown} neznámých` : '');
}

/** Optional read surface. Percentages never change assignments or imply that a tool was invoked. */
export function experiencePanel(floor: string, view: () => HarnessHierarchyView | undefined, signal: AbortSignal, changed: () => void) {
  let rows = new Map<string, Experience>(), loaded = false, ticket = 0, request: AbortController | undefined;
  const problem = h('input', { placeholder: 'např. ts.references', maxlength: 200, 'aria-label': 'Typ úkolu pro zkušenosti' });
  const button = h('button.btn', { type: 'button' }, 'Načíst zkušenosti');
  const status = h('p', { role: 'status' }, 'Zkušenosti zatím nenačteny.');
  const el = h('details.harness-experience', {}, h('summary', {}, 'Zkušenosti a úspěšnost nástrojů'),
    h('p', {}, 'Výsledky karet v tomto projektu a prostoru, kde byl nástroj vybrán. Uvedená verze, velikost vzorku a interval pomáhají posoudit procento. Skutečné použití a příčinný přínos nemusí být doložené.'),
    h('div.harness-toolbar', {}, h('label', {}, 'Typ úkolu', problem), button), status);
  const key = () => { const current = view(); return JSON.stringify([current?.target, current?.level, current?.revision, current?.pathDigest]); };
  async function load() {
    if (!view() || !problem.value.trim()) { status.textContent = 'Vyplňte typ úkolu podle knihovny.'; return; }
    const seq = ++ticket, scope = key(), requestedProblem = problem.value.trim(), controller = new AbortController();
    request?.abort(); request = controller;
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    button.disabled = true; status.textContent = 'Načítání zkušeností…';
    try {
      const response = await fetch('/api/harness/recommend?' + new URLSearchParams({ floor, task: view()!.target, problem: requestedProblem }), { signal: controller.signal });
      if (response.status === 404) throw new Error('Tato instalace zatím neposkytuje měření zkušeností.');
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(object(data) && typeof data.error === 'string' ? data.error : 'Zkušenosti nelze načíst.');
      if (!object(data) || data.schema !== 'harness.recommendation/1' || !Array.isArray(data.candidates) || data.candidates.length > 100) throw new Error('Neplatná odpověď měření.');
      const next = new Map<string, Experience>();
      for (const item of data.candidates) {
        if (!object(item) || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || !rate(item.verified) || !rate(item.reported)
          || !count(item.tasks) || !Array.isArray(item.missing) || item.missing.some((n: unknown) => typeof n !== 'string')) throw new Error('Neplatné údaje zkušenosti.');
        next.set(item.id, item as unknown as Experience);
      }
      if (signal.aborted || seq !== ticket || scope !== key() || requestedProblem !== problem.value.trim()) return;
      rows = next; loaded = true;
      status.textContent = data.history?.status === 'available'
        ? 'Načteno pro ' + requestedProblem + (data.history.limited ? ' · seznam historie je omezený.' : '.')
        : 'Zdroj měření je nedostupný; chybějící výsledky zůstávají neznámé.';
      changed();
    } catch (error) { if (!signal.aborted && seq === ticket && scope === key()) { rows.clear(); loaded = false; status.textContent = (error as Error).message; changed(); } }
    finally { signal.removeEventListener('abort', cancel); if (request === controller) request = undefined; if (seq === ticket) button.disabled = false; }
  }
  button.onclick = () => void load();
  function reset() { request?.abort(); request = undefined; ticket++; rows.clear(); loaded = false; button.disabled = false; status.textContent = 'Zkušenosti zatím nenačteny.'; changed(); }
  problem.oninput = reset;
  return { el, reset, badge(id: string) {
    const item = rows.get(id);
    if (!item) return h('small.harness-experience-note', {}, loaded ? 'Pro tento typ úkolu bez posouzení.' : 'Zkušenosti zatím nenačteny.');
    return h('span.harness-experience-badge', {}, h('small', {}, 'Verze ' + item.digest.slice(0, 10)),
      h('small', {}, line('Lidské potvrzení', item.verified) + (item.tasks ? ` · ${item.tasks} různých karet` : '')),
      h('small', {}, line('Hlášení agenta', item.reported)),
      ...(item.missing.length ? [h('small', {}, 'Požadavky k ověření: ' + item.missing.join(', '))] : []));
  } };
}
