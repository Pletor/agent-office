import type { HarnessCatalog, HarnessCategory, HarnessEntry, HarnessText } from '../../../../shared/harness';
import type { HarnessKit } from '../../../../shared/harness-kit';
import type { HarnessLevel } from '../../../../shared/harness-cascade';
import { HARNESS_LEVEL_NAMES } from '../../../../shared/harness-navigation';
import { h, toast } from '../../../ui/dom';
import { HARNESS_BOXES, PHASES, PROBLEMS, REASONS, boxOf, packageChecks, type HarnessBox } from './boxes-model';
import { categoryName } from './names';
import { isDefinition, itemBlock } from './item-view';
import type { HarnessChoice } from '../../../../shared/harness-navigation';
import './boxes.css';

export interface BoxesHost {
  floor(): string; signal: AbortSignal;
  /** The library's one package (the footer's Vybráno N / 24): the boxes and the reader fill the same set. */
  selected(): ReadonlySet<string>; toggle(id: string): void; replace(ids: string[]): void;
  browse(category: HarnessCategory): void;
  /** Switch the package on at the level open in Výbava (Projekt, or a canvas node once the floor is bound to Opora). */
  assign(ids: string[]): void;
}
const LIMIT = 8;
/** The orchestrator's path through the same library, with the same rights as a person in the browser. */
const ORCHESTRATOR: [string, string][] = [
  ['Najde prostředky ve schránkách', 'office-harness --search "slova" --category CATEGORY'],
  ['Nechá si doporučit balíček pro typ úkolu', 'office-harness --recommend PROBLEM'],
  ['Složí a ověří balíček (otisky, limit 24 / 96 KiB)', 'office-harness --kit PROBLEM IDS'],
  ['Přiřadí ho úrovni: projekt, stránka až karta canvasu', 'office-harness --configure LEVEL vrstva.json --task KEY'],
  ['Pošle kit do karty jako návrh změny zadání (fields.harness)', 'office-harness --propose CARD-KEY PROBLEM IDS'],
  ['Po přijetí člověkem kartu převezme worker a čte svůj balíček', 'office-harness --accepted-kit'],
];
/** replaceChildren with the optional parts left out. */
const parts = (...children: (Node | string | null | false)[]) => children.filter((child): child is Node | string => !!child);
const resources = (n: number) => n + (n >= 2 && n <= 4 ? ' prostředky' : ' prostředků');
const things = (n: number) => n + (n === 1 ? ' věc' : n >= 2 && n <= 4 ? ' věci' : ' věcí');

/** Schránky: the twelve boxes around the model, what each holds and uses, and the package composed and verified from them. */
export function boxesPage(host: BoxesHost) {
  let catalog: HarnessCatalog | undefined, used: Set<string> | undefined, usedAt = '';
  let current = 6, expanded = false, problem = PROBLEMS[0][0], busy = false;
  let verified: { sig: string; kit: HarnessKit; bytes: number } | undefined, failure = '';
  let cards: HarnessChoice[] = [], bound = false, card = '', sent: { id: string; card: string; resources: number; opora: string } | undefined;
  const reasons = new Map<string, string>();
  const hub = h('div.harness-hub', { role: 'group', 'aria-label': 'Schránky' });
  const detail = h('section.harness-card.harness-box-detail', { 'aria-live': 'polite' });
  const preview = h('section.harness-card.harness-box-preview', { hidden: true, 'aria-label': 'Náhled', tabindex: -1 });
  const pack = h('section.harness-card.harness-pack', { 'aria-label': 'Balíček' });
  const el = h('section.harness-boxes', { 'aria-label': 'Schránky výbavy', tabindex: -1 },
    h('span.harness-eyebrow', {}, 'Harness · schránky výbavy'), h('h3', {}, 'Dvanáct schránek kolem modelu'),
    h('p.harness-boxes-intro', {}, 'Každá schránka ukazuje, co se na tomto patře používá, co v knihovně čeká a co dělá kancelář sama. Z věcí složíte balíček, prohlédnete si, co v něm je a kdy se to použije, necháte ho ověřit serverem a předáte ho do karty.'),
    h('p.harness-legend', {}, h('span.harness-pill', { 'data-tone': 'ok' }, 'Používá se'), ' ve výbavě patra · ',
      h('span.harness-pill', {}, 'V knihovně'), ' k dispozici · ', h('span.harness-pill', { 'data-tone': 'wait' }, 'Kancelář'), ' funkce kódu s příkazem'),
    hub, detail, preview, pack);
  const sig = () => problem + ' ' + [...host.selected()].join(' ');
  const entries = (box: HarnessBox) => (catalog?.entries ?? []).filter(entry => box.categories.includes(entry.category));
  const isUsed = (entry: HarnessEntry) => !!used && (used.has(entry.id) || (entry.aliases ?? []).some(alias => used!.has(alias)));
  async function get<T>(path: string, query: [string, string][]): Promise<T> {
    const response = await fetch('/api/harness' + path + '?' + new URLSearchParams([['floor', host.floor()], ...query]), { signal: host.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'Přihlaste se znovu.' : data.error || 'Server požadavek odmítl (' + response.status + ').');
    return data as T;
  }
  const command = (text: string) => h('code.harness-box-command', {}, text);

  function tile(box: HarnessBox, index: number) {
    const own = entries(box), on = own.filter(isUsed).length, inPack = own.filter(entry => host.selected().has(entry.id)).length;
    return h('button.harness-box', { type: 'button', 'data-box': box.n, 'data-side': box.side, 'aria-pressed': String(index === current), onclick: () => { current = index; expanded = false; render(); detail.scrollIntoView({ block: 'nearest' }); } },
      h('span.harness-box-title', {}, h('b', { 'aria-hidden': 'true' }, String(box.n)), box.title),
      h('small', {}, box.motto),
      h('span.harness-box-counts', {},
        used && box.categories.length ? h('span.harness-pill', { 'data-tone': on ? 'ok' : undefined }, on + ' používá') : null,
        !box.categories.length && !box.functions.length ? h('span.harness-pill', {}, 'zatím prázdné') : null,
        box.categories.length ? h('span.harness-pill', {}, own.length + ' v knihovně') : null,
        box.functions.length ? h('span.harness-pill', { 'data-tone': 'wait' }, box.functions.length + '× kancelář') : null),
      inPack ? h('strong.harness-box-pack', {}, inPack + ' v balíčku') : null);
  }
  function row(entry: HarnessEntry) {
    const checkbox = h('input', { type: 'checkbox', checked: host.selected().has(entry.id), 'aria-label': entry.title + ' v balíčku',
      disabled: !host.selected().has(entry.id) && host.selected().size >= 24 });
    checkbox.onchange = () => host.toggle(entry.id);
    return h('li.harness-box-item', { 'data-used': String(!!isUsed(entry)) },
      h('div', {}, h('strong', {}, isDefinition(entry.path) ? h('span.harness-pill', { 'data-tone': 'ok' }, 'Definice') : null, isDefinition(entry.path) ? ' ' : null, entry.title), h('small', {}, categoryName(entry.category) + ' · ' + entry.source + (isUsed(entry) ? ' · používá se' : ''))),
      h('button.btn', { type: 'button', onclick: () => void show(entry) }, 'Prohlédnout'),
      h('label.harness-box-check', {}, checkbox, 'V balíčku'));
  }
  function render() {
    hub.replaceChildren(...HARNESS_BOXES.map(tile), h('div.harness-model', { 'aria-hidden': 'true' },
      h('span', {}, 'MODEL'), h('strong', {}, String(host.selected().size)), h('small', {}, 'v balíčku · ' + PROBLEMS.find(p => p[0] === problem)![1])));
    const box = HARNESS_BOXES[current], own = entries(box), on = own.filter(isUsed);
    // Defined things first: they say what runs and what they are made of.
    const rest = own.filter(entry => !isUsed(entry)).sort((a, b) => Number(isDefinition(b.path)) - Number(isDefinition(a.path)));
    const shown = expanded ? rest : rest.slice(0, LIMIT);
    detail.replaceChildren(...parts(
      h('span.harness-eyebrow', {}, `Schránka ${box.n} · ${box.side === 'control' ? 'Řízení a kvalita' : box.side === 'centre' ? 'Střed' : 'Výbava agenta'}`),
      h('h4', {}, box.title + ' · ' + box.motto),
      !box.categories.length ? null : used ? h('h5', {}, h('span.harness-pill', { 'data-tone': 'ok' }, 'Používá se'), ' ', usedAt) : h('p.harness-muted', {}, 'Účinnou výbavu patra se nepodařilo zjistit; nic se neodhaduje.'),
      !box.categories.length ? null : used && on.length ? h('ul.harness-box-items', {}, ...on.map(row)) : used ? h('p.harness-muted', {}, 'Na tomto patře se z této schránky nic nepoužívá.') : null,
      box.categories.length ? h('h5', {}, h('span.harness-pill', {}, 'V knihovně'), ` ${things(rest.length)} (${box.categories.map(categoryName).join(', ')})`) : null,
      shown.length ? h('ul.harness-box-items', {}, ...shown.map(row)) : null,
      rest.length > LIMIT ? h('div.harness-box-more', {},
        h('button.btn', { type: 'button', onclick: () => { expanded = !expanded; render(); } }, expanded ? 'Ukázat méně' : `Ukázat dalších ${rest.length - LIMIT}`),
        h('button.btn', { type: 'button', onclick: () => host.browse(box.categories[0]) }, 'Hledat v Prostředcích')) : null,
      box.functions.length ? h('h5', {}, h('span.harness-pill', { 'data-tone': 'wait' }, 'Kancelář'), ' funkce kódu, nejsou v balíčku') : null,
      box.functions.length ? h('ul.harness-box-functions', {}, ...box.functions.map(([name, what, how]) => h('li', {}, h('strong', {}, name), h('span', {}, what), command(how)))) : null,
      box.gap ? h('p.harness-box-gap', {}, box.gap) : null));
    renderPack();
  }
  async function show(entry: HarnessEntry) {
    preview.hidden = false;
    preview.replaceChildren(h('p.harness-muted', {}, 'Načítání ' + entry.title + '…'));
    preview.scrollIntoView({ block: 'nearest' });
    try {
      const text = await get<HarnessText>('/file', [['id', entry.id]]);
      const box = boxOf(entry.category), phase = PHASES.find(p => p[2].includes(entry.category));
      const toggle = h('button.btn.primary', { type: 'button', onclick: () => { host.toggle(entry.id); void show(entry); } }, host.selected().has(entry.id) ? 'Odebrat z balíčku' : 'Přidat do balíčku');
      preview.replaceChildren(...parts(
        h('button.btn.harness-box-close', { type: 'button', 'aria-label': 'Zavřít náhled', onclick: () => { preview.hidden = true; } }, '✕'),
        h('span.harness-eyebrow', {}, `Schránka ${box?.n ?? '–'} · ${box?.title ?? ''} · ${categoryName(entry.category)}`),
        h('h4', {}, text.title),
        h('dl.harness-box-facts', {},
          h('dt', {}, 'Kdy se použije'), h('dd', {}, phase ? phase[0] + ': ' + phase[1] : '–'),
          h('dt', {}, 'Na tomto patře'), h('dd', {}, used ? (isUsed(entry) ? 'Používá se (' + usedAt + ')' : 'Nepoužívá se') : 'Nezjištěno'),
          h('dt', {}, 'Kde je'), h('dd', {}, command(text.source + ' / ' + text.path)),
          h('dt', {}, 'Verze'), h('dd', {}, (entry.version ? 'v' + entry.version + ' · ' : '') + (entry.digest ? 'otisk ' + entry.digest.slice(0, 12) : 'bez otisku'))),
        text.item ? itemBlock(text.item, id => { const part = catalog?.entries.find(candidate => candidate.id === id); if (part) void show(part); }) : null,
        h('pre.harness-box-text', {}, text.text.length > 4000 ? text.text.slice(0, 4000) + '\n…' : text.text),
        h('div.harness-box-actions', {}, toggle, command('office-harness --read ' + entry.id))));
      preview.focus({ preventScroll: true });
    } catch (error) { if (!host.signal.aborted) preview.replaceChildren(h('p.harness-muted', {}, (error as Error).message)); }
  }
  async function recommend() {
    busy = true; failure = ''; renderPack();
    try {
      const result = await get<{ selection?: { resource: string; reason: string }[]; proposalStatus?: string }>('/recommend', [['problem', problem]]);
      if (result.proposalStatus === 'blocked' || !result.selection) throw new Error('Doporučení je zablokované (chybějící požadavky nebo karanténa).');
      reasons.clear();
      for (const item of result.selection) reasons.set(item.resource, REASONS[item.reason] ?? item.reason);
      host.replace(result.selection.map(item => item.resource).slice(0, 24));
    } catch (error) { failure = (error as Error).message; }
    finally { busy = false; render(); }
  }
  async function propose() {
    if (!verified || !card) return;
    busy = true; failure = ''; renderPack();
    try {
      const response = await fetch('/api/harness/propose?' + new URLSearchParams({ floor: host.floor() }), { method: 'POST', signal: host.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card, problem, resources: [...host.selected()] }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Opora návrh odmítla (' + response.status + ').');
      sent = data;
    } catch (error) { failure = (error as Error).message; }
    finally { busy = false; renderPack(); }
  }
  async function verify() {
    busy = true; failure = ''; renderPack();
    const at = sig();
    try {
      const kit = await get<HarnessKit>('/kit', [['problem', problem], ...[...host.selected()].map(id => ['resource', id] as [string, string])]);
      verified = { sig: at, kit, bytes: new Blob([JSON.stringify(kit)]).size }; sent = undefined;
    } catch (error) { verified = undefined; failure = (error as Error).message; }
    finally { busy = false; renderPack(); }
  }
  /** Poslat do karty: the verified kit becomes a proposed change of one card's specification in Opora. */
  function sendToCard() {
    if (sent) return h('p.harness-pack-sent', { role: 'status' }, h('span.harness-pill', { 'data-tone': 'ok' }, 'Návrh je v Opoře'),
      ` Karta ${sent.card}: ${resources(sent.resources)}. Přijměte ho v Opoře (Plán → Návrhy změn); pak kartu převezme worker a dostane přesně tento balíček.`);
    if (!bound) return h('p.harness-muted', {}, 'Do karty pošlete balíček, až bude patro připojené k Opoře (Výbava → Připojit otevřenou Oporu).');
    if (!cards.length) return h('p.harness-muted', {}, 'Na připojeném plátně Opory nejsou žádné karty.');
    const select = h('select', { 'aria-label': 'Karta v Opoře', disabled: busy }, h('option', { value: '' }, 'Vyberte kartu…'),
      ...cards.map(choice => h('option', { value: choice.key, selected: choice.key === card }, choice.name)));
    select.onchange = () => { card = select.value; renderPack(); };
    return h('div.harness-pack-send', {}, h('strong', {}, 'Poslat do karty'), select,
      h('button.btn.primary', { type: 'button', disabled: busy || !card, onclick: () => void propose() }, 'Poslat do karty v Opoře'),
      h('small', {}, 'Karta dostane balíček v zadání; worker ho převezme s kartou (kontext v2).'));
  }
  function renderPack() {
    const chosen = (catalog?.entries ?? []).filter(entry => host.selected().has(entry.id)), ids = chosen.map(entry => entry.id).join(' ');
    const fresh = verified?.sig === sig() ? verified : undefined;
    const select = h('select', { 'aria-label': 'Typ úkolu', disabled: busy }, ...PROBLEMS.map(([id, name]) => h('option', { value: id, selected: id === problem }, name)));
    select.onchange = () => { problem = select.value; render(); };
    const json = () => JSON.stringify(fresh!.kit, null, 2);
    pack.replaceChildren(...parts(
      h('div.harness-pack-head', {}, h('h4', {}, `Balíček · ${things(chosen.length)} z 24`), select,
        h('button.btn', { type: 'button', disabled: busy, onclick: () => void recommend() }, 'Doporučit balíček'),
        h('button.btn.primary', { type: 'button', disabled: busy || !chosen.length, onclick: () => void verify() }, busy ? 'Pracuji…' : 'Složit a ověřit')),
      chosen.length ? h('div.harness-pack-grid', {},
        h('div', {}, h('h5', {}, 'Co je v balíčku'), h('ul.harness-box-items', {}, ...chosen.map(entry => h('li.harness-box-item', {},
          h('div', {}, h('strong', {}, entry.title), h('small', {}, (boxOf(entry.category)?.title ?? '') + ' · ' + categoryName(entry.category) + (reasons.has(entry.id) ? ' · ' + reasons.get(entry.id) : ''))),
          h('button.btn', { type: 'button', onclick: () => void show(entry) }, 'Prohlédnout'),
          h('button.btn', { type: 'button', 'aria-label': 'Odebrat ' + entry.title, onclick: () => host.toggle(entry.id) }, '✕'))))),
        h('div', {}, h('h5', {}, 'Co se bude dít'), h('ol.harness-pack-timeline', {}, ...PHASES.map(([name, hint, categories]) => {
          const here = chosen.filter(entry => categories.includes(entry.category));
          return here.length ? h('li', {}, h('strong', {}, name), h('small', {}, ' ' + hint), h('span', {}, here.map(entry => entry.title).join(' · '))) : null;
        }))))
        : h('p.harness-muted', {}, 'Balíček je prázdný. Zaškrtněte věci ve schránkách, nebo zvolte typ úkolu a Doporučit balíček.'),
      failure ? h('p.harness-pack-error', { role: 'alert' }, failure) : null,
      verified && !fresh && !failure ? h('p.harness-pack-error', {}, 'Balíček se od ověření změnil. Složte a ověřte ho znovu.') : null,
      fresh ? h('div.harness-pack-verdict', { role: 'status' },
        h('h5', {}, h('span.harness-pill', { 'data-tone': 'ok' }, 'Ověřeno serverem'), ` ${fresh.kit.resources.length === 1 ? '1 prostředek s otiskem, existuje a je čitelný' : resources(fresh.kit.resources.length) + ' s otisky, všechny existují a jsou čitelné'}`),
        h('ul.harness-pack-checks', {}, ...packageChecks(chosen, used, fresh.bytes).map(([tone, label, text]) => h('li', {}, h('span.harness-pill', { 'data-tone': tone }, label), h('span', {}, text)))),
        fresh.kit.resources.length > chosen.length ? h('p.harness-muted', {}, `Včetně ${fresh.kit.resources.length - chosen.length} částí definic (návody, reference, skripty), každá s vlastním otiskem.`) : null,
        h('ol.harness-flow', {}, ...['Složeno a ověřeno', 'Návrh do karty v Opoře', 'Člověk přijme', 'Worker převezme kartu', 'Výsledek a měření'].map(step => h('li', {}, step))),
        sendToCard(),
        h('div.harness-box-actions', {},
          h('button.btn.primary', { type: 'button', onclick: () => void navigator.clipboard.writeText(json()).then(() => toast('Kit zkopírován'), () => toast('Schránka nefunguje; použijte Stáhnout kit.', 'warn')) }, 'Zkopírovat kit'),
          h('button.btn', { type: 'button', onclick: () => { const url = URL.createObjectURL(new Blob([json()], { type: 'application/json' })); h('a', { href: url, download: 'harness-kit.json' }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } }, 'Stáhnout kit'))) : null,
      chosen.length ? h('div.harness-pack-assign', {},
        h('div', {}, h('strong', {}, 'Přiřadit workerům'), h('span', {}, ' Zapne balíček na úrovni otevřené ve Výbavě: Projekt (repozitář), nebo stránka až karta na canvasu Opory. Pak Uložit výbavu; dostane ho každá další práce na té úrovni.')),
        h('button.btn', { type: 'button', onclick: () => host.assign(chosen.map(entry => entry.id)) }, 'Přiřadit do výbavy')) : null,
      h('details.harness-pack-orchestrator', {}, h('summary', {}, 'Jak to udělá orchestrátor Opory'),
        h('ol', {}, ...ORCHESTRATOR.map(([what, how]) => h('li', {}, h('span', {}, what), command(how.replace('PROBLEM', problem).replace('IDS', ids || 'ID …'))))))));
  }
  return {
    el, refresh: render,
    catalog(value: HarnessCatalog) { catalog = value; verified = undefined; render(); },
    /** The floor's effective profile, or null when the server cannot say (legacy server, error). */
    hierarchy(view: { effective?: Record<string, { binding: unknown; scope: string }>; level?: string; bound?: unknown; choices?: HarnessChoice[] } | null) {
      bound = !!view?.bound; cards = (view?.choices ?? []).filter(choice => choice.level === 'task');
      if (!cards.some(choice => choice.key === card)) card = '';
      if (!view?.effective) { used = undefined; usedAt = ''; render(); return; }
      used = new Set(Object.values(view.effective).flatMap(item => item.binding && typeof item.binding === 'object' && 'resource' in item.binding ? [String(item.binding.resource)] : []));
      usedAt = 'účinná výbava úrovně ' + (HARNESS_LEVEL_NAMES[view.level as HarnessLevel] ?? view.level ?? '');
      render();
    },
  };
}
