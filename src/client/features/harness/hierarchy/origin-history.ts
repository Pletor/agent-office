import { h } from '../../../ui/dom';
import { HARNESS_LEVEL_NAMES, type HarnessHierarchyView } from '../../../../shared/harness-navigation';
import { parseOriginHistory, type OriginCohort } from '../../../../shared/harness-origin-history';

const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });
function resultLine(c: OriginCohort) {
  const r = c.rate, n = r.pass + r.fail, interval = r.interval95;
  return (c.tier === 'verified' ? 'Lidské uzavření' : 'Hlášení agenta') + ': '
    + (n ? `${number.format(100 * r.pass / n)} % · ${r.pass}/${n}` : 'nezjištěno')
    + ` · ${r.unknown} neznámých · ${c.tasks} karet`
    + (interval ? ` · 95% interval ${number.format(interval[0])}–${number.format(interval[1])} %` : '');
}

/** A separate historical comparison; never edits the checkbox draft or recommendations. */
export function originHistoryPanel(floor: string, view: () => HarnessHierarchyView | undefined, signal: AbortSignal) {
  let ticket = 0, request: AbortController | undefined;
  const button = h('button.btn', { type: 'button' }, 'Načíst historii původu');
  const status = h('p', { role: 'status' }, 'Historie původu zatím nenačtena.');
  const rows = h('div.harness-origin-rows');
  const el = h('details.harness-origin-history', {}, h('summary', {}, 'Historie výsledků podle původu výbavy'),
    h('p', {}, 'Původ zapsaný v přijaté výbavě, ve vybraném projektu a prostoru. Není to ověřené členství v hierarchii. Více původů může sdílet stejný běh; jejich počty nesčítejte. Starší běhy bez původu nejsou přiřazeny odhadem.'),
    button, status, rows);
  const key = () => { const v = view(); return JSON.stringify([v?.target, v?.level, v?.bindingRevision, v?.pathDigest]); };
  function reset() { request?.abort(); request = undefined; ticket++; button.disabled = false; rows.replaceChildren(); status.textContent = 'Historie původu zatím nenačtena.'; }
  signal.addEventListener('abort', reset, { once: true });
  button.onclick = async () => {
    const current = view(), place = current?.bound;
    if (!current || !place) { status.textContent = 'Nejprve připojte projekt Opory.'; return; }
    const seq = ++ticket, scope = key(), controller = new AbortController();
    request?.abort(); request = controller; button.disabled = true; rows.replaceChildren(); status.textContent = 'Načítání historie původu…';
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    try {
      const response = await fetch('/api/harness/hierarchy?' + new URLSearchParams({ floor, node: current.target, scope: current.level, 'origin-history': '1' }), { signal: controller.signal });
      if (!response.ok) throw new Error('Historie původu není v této instalaci dostupná.');
      const report = parseOriginHistory(await response.json(), place.project, place.workspace);
      if (report.cohorts.some(c => c.origin.scope !== current.level || c.origin.node !== (current.target || null))) throw new Error('Historie neodpovídá vybranému původu.');
      if (signal.aborted || seq !== ticket || key() !== scope) return;
      status.textContent = `${HARNESS_LEVEL_NAMES[current.level]} · posledních ${report.window.examined} z nejvýše ${report.window.limit} zařazených běhů · vyřazeno ${report.window.excluded}`
        + (report.limited ? ' · omezený výpis' : '')
        + (report.omittedCohortContributions ? ` · nezobrazené příspěvky ${report.omittedCohortContributions}` : '')
        + '. Použití nástroje ani příčinný přínos tím nejsou prokázány.';
      rows.replaceChildren(...report.cohorts.map(c => h('p.harness-origin-row', {},
        h('strong', {}, c.resource), h('small', {}, `${c.category} · ${c.problem} · verze ${c.versionDigest.slice(0, 12)}`),
        h('small', {}, resultLine(c)))),
        ...(!report.cohorts.length ? [h('p', {}, 'Pro tento původ nejsou v načteném okně výsledky. Neznámý původ není úspěch ani selhání.')] : []));
    } catch (error) { if (!signal.aborted && seq === ticket && key() === scope) status.textContent = (error as Error).message; }
    finally { signal.removeEventListener('abort', cancel); if (request === controller) request = undefined; if (seq === ticket) button.disabled = false; }
  };
  return { el, reset };
}
