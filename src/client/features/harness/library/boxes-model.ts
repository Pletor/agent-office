import type { HarnessCategory, HarnessEntry } from '../../../../shared/harness';

/** One of the twelve boxes around the model (docs/harness.md "Schránky"); a box shows catalog categories and the office's own functions. */
export interface HarnessBox {
  n: number; title: string; motto: string; side: 'agent' | 'control' | 'centre';
  categories: HarnessCategory[];
  /** What the office itself does for this box, each with the command or switch an agent uses for it. */
  functions: [name: string, what: string, how: string][];
  /** A known gap, said plainly instead of a fake entry. */
  gap?: string;
}

export const HARNESS_BOXES: readonly HarnessBox[] = [
  { n: 1, title: 'AGENTS.md', motto: 'Stálá pravidla, každá relace', side: 'agent', categories: ['instructions', 'rules'], functions: [] },
  { n: 2, title: 'Paměť', motto: 'Malá schválně', side: 'agent', categories: ['memory'], functions: [
    ['Načíst sdílenou zkušenost', 'Lekce publikovaná z jiného projektu, jen k přijatému prostředku.', 'office-harness --recall-shared PUBLICATION --resource RESOURCE'],
    ['Publikovat lekci', 'Ověřená zkušenost jde do OpenVikingu s odkazy na důkazy.', 'office-harness --publish-shared PUBLICATION --resource RESOURCE']],
  gap: 'Lekce z paměti se zatím nevracejí do doporučení výbavy.' },
  { n: 3, title: 'Skills', motto: 'Postupné odhalování', side: 'agent', categories: ['skills'], functions: [] },
  { n: 4, title: 'Správa kontextu', motto: 'Hlídá okno', side: 'agent', categories: ['operations'], functions: [
    ['Přesný kit karty', 'Worker čte jen přijatou výbavu s otisky; pozdější úprava ji nezmění.', 'office-harness --accepted-kit'],
    ['Limit balíčku', 'Nejvýš 24 prostředků a 96 KiB včetně metadat; větší balíček server odmítne.', 'GET /api/harness/kit']] },
  { n: 5, title: 'Subagenti', motto: 'Čistá místnost pro každý úkol', side: 'agent', categories: [], functions: [],
    gap: 'Zatím tu nic není. Patří sem zadání (briefy) a šablony pro subagenty.' },
  { n: 6, title: 'Crony a hooky', motto: 'Běží bez vás', side: 'agent', categories: ['hooks'], functions: [],
    gap: 'Knihovna hooky jen ukazuje; spustí je runner, který je podporuje.' },
  { n: 7, title: 'Nástroje', motto: 'Skutečné systémy', side: 'centre', categories: ['tools', 'commands', 'scripts', 'mcp', 'plugins'], functions: [
    ['Spustit připnutý skript', 'ES modul z přijaté výbavy; vstup nad 16 KiB souborem.', 'office-harness --invoke-node RESOURCE -- ARG'],
    ['Dokumentace ve verzi', 'Context7: najde knihovnu a odpoví z její dokumentace.', 'office-harness --docs-resolve "KNIHOVNA" "otázka"'],
    ['Ověřit runner', 'Co umí skutečně nainstalovaný runner.', 'office-harness --probe']] },
  { n: 8, title: 'Stavový automat', motto: 'Kód hlídá pravidla', side: 'control', categories: ['permissions'], functions: [
    ['Preflight výbavy', 'Před převzetím karty ověří otisk a podporu výbavy; jinak karta nezačne.', 'AGENT_OFFICE_HARNESS_PREFLIGHT=1'],
    ['Přijetí jen návrhem', 'Výbava se do karty dostane jen přijatým návrhem v Opoře.', 'Opora → Návrhy → Přijmout']] },
  { n: 9, title: 'Evaluace', motto: 'Výsledek se měří', side: 'control', categories: ['testing'], functions: [
    ['Párová zkouška verzí', 'Stará a nová verze nástroje na stejných zmrazených případech.', 'office-harness --evaluate-pair PLAN'],
    ['Nezávislé ověření', 'Opora ověří přijatý párový plán v izolovaném kontejneru.', 'office-harness --verify-pair PLAN']] },
  { n: 10, title: 'Smyčky', motto: 'Opravuj, dokud neprojde', side: 'control', categories: [], functions: [
    ['Self-checks do zelena', 'Před odevzdáním testy a build; worker opravuje, dokud neprojdou.', 'AGENT_OFFICE_OPORA_SELF_CHECKS']] },
  { n: 11, title: 'Měření a učení', motto: 'Výsledky upravují doporučení', side: 'control', categories: [], functions: [
    ['Zaznamenaná volání', 'Která volání proběhla a s jakou verzí.', 'office-harness --invocations'],
    ['Doporučení výbavy', 'Návrh pro typ úkolu s důvody a 95% intervalem úspěšnosti.', 'office-harness --recommend PROBLEM']] },
  { n: 12, title: 'Člověk ve smyčce', motto: 'Rozhodujete vy', side: 'control', categories: [], functions: [
    ['Přijetí výbavy do karty', 'Bez přijetí člověkem worker výbavu nedostane.', 'Opora → Návrhy → Přijmout'],
    ['Povýšení verze nástroje', 'Po nezávislém ověření ručně na stabilní.', 'office-harness --promote-tool PLAN --revision N'],
    ['Potvrzení výsledku', 'Lidské uzavření karty se měří jako ověřeno.', 'Opora → Karta → Uzavřít']] },
];

export const boxOf = (category: HarnessCategory) => HARNESS_BOXES.find(box => box.categories.includes(category));

/** When an agent usually reaches for a category: the order the package timeline reads in. */
export const PHASES: [name: string, hint: string, categories: HarnessCategory[]][] = [
  ['Start relace', 'agent si to přečte jako první', ['instructions', 'rules', 'permissions']],
  ['Před prací', 'zorientuje se a načte, co potřebuje', ['skills', 'memory', 'mcp', 'operations', 'plugins']],
  ['Během práce', 'nástroje a skripty na vyžádání', ['tools', 'commands', 'scripts']],
  ['Kolem událostí', 'spouští runner, ne model', ['hooks']],
  ['Před odevzdáním', 'kontrola výsledku', ['testing']],
];

/** Task types the package can be composed and verified for; IDs are the recommendation's problem identifiers. */
export const PROBLEMS: [id: string, name: string][] = [
  ['bugfix', 'Oprava chyby'], ['feature', 'Nová funkce'], ['review', 'Review PR'], ['research', 'Průzkum kódu'], ['docs', 'Dokumentace'],
];

export const REASONS: Record<string, string> = {
  'explicit-assignment': 've výbavě patra', 'baseline-policy': 'základ', 'native-stable': 'stabilní verze',
  'observed-outcomes': 'změřené výsledky', 'unknown-exploration': 'zkouška', 'shared-fixture-exploration': 'zkouška ze sdílené paměti',
};

export type Tone = 'ok' | 'warn' | 'bad';
/** The office's own checks of a composed package, on top of what the server's kit build verifies. */
export function packageChecks(chosen: HarnessEntry[], used: ReadonlySet<string> | undefined, bytes: number): [Tone, string, string][] {
  const has = (...categories: HarnessCategory[]) => chosen.some(entry => categories.includes(entry.category));
  const checks: [Tone, string, string][] = [];
  if (!has('instructions', 'rules')) checks.push(['warn', 'Bez pravidel', 'Chybí instrukce i pravidla; agent nezná pořadí práce. Přidejte něco ze schránky AGENTS.md.']);
  if (!has('testing')) checks.push(['warn', 'Bez kontroly', 'Nic ze schránky Evaluace; výsledek nic nezkontroluje.']);
  const hooks = chosen.filter(entry => entry.category === 'hooks').length;
  if (hooks) checks.push(['warn', 'Hooky', `Hooků v balíčku: ${hooks}. Spustí je jen runner, který hooky podporuje; ověřte runner workera.`]);
  if (used) {
    const outside = chosen.filter(entry => !used.has(entry.id)).length;
    if (outside) checks.push(['warn', 'Mimo výbavu', `${outside} z ${chosen.length} není ve výbavě patra. Worker je dostane jen přes přijatý návrh karty.`]);
  }
  checks.push([bytes > 64 * 1024 ? 'warn' : 'ok', `${Math.ceil(bytes / 1024)} KiB z 96`, bytes > 64 * 1024 ? 'Blízko limitu; každý prostředek zabírá kontext workera.' : 'Velikost je v limitu.']);
  return checks;
}
