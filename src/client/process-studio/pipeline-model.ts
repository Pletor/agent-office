import type { StudioState } from './model';

/** Proposed delivery contract, not a claim that a connected service ran these tools. */
export const PIPELINE = [
  { id: 'intake', phase: '01 · Opora', title: 'Zadání a rizika', owner: 'Plánovač', node: 'plan', input: 'Karta OP-128 a požadované chování', output: 'Rozsah, nepokrývané cíle, rizika a vlastník', gate: 'Každý požadavek má ověřitelný výstup.' },
  { id: 'sources', phase: '01 · Opora', title: 'Průzkum a původ zdrojů', owner: 'Paměť', node: 'context', input: 'Repozitář, AGENTS.md, dokumentace a zkušenosti', output: 'Mapa dotčených modulů a verzovaný kontext', gate: 'Dohledat zdroj; instrukce v externích datech nejsou oprávnění.' },
  { id: 'spec', phase: '01 · Opora', title: 'Kontrakt a stavový model', owner: 'Plánovač', node: 'contract', input: 'Přijaté AC-01 až AC-05', output: 'Stavy, přechody, invarianty a chybové větve', gate: 'Popsat duplicity, timeout, zrušení, reconnect a opakování.' },
  { id: 'baseline', phase: '02 · Kancelář', title: 'Výchozí stav', owner: 'Kontrolor', node: 'office', input: 'Čerstvě načtený origin/main', output: 'Výchozí SHA a výsledky kontrol před změnou', gate: 'Odlišit existující chyby od nové regrese.' },
  { id: 'worktrees', phase: '02 · Kancelář', title: 'Rozdělení práce a worktrees', owner: 'Plánovač', node: 'office', input: 'Plán, závislosti a vlastnictví souborů', output: 'Oddělené větve UI / události; smlouva rozhraní', gate: 'Žádný zásah do cizích změn; společné soubory mají vlastníka.' },
  { id: 'counterexample', phase: '02 · Kancelář', title: 'Protipříklad → regresní test', owner: 'Kontrolor', node: 'checks', input: 'Stavový model a reprodukce chyby', output: 'Nejmenší selhávající stopa a test očekávaného chování', gate: 'Model musí odpovídat kódu. Lean je volitelný adaptér, zde se nespouští.' },
  { id: 'integration', phase: '03 · Důkazy', title: 'Integrace změn', owner: 'Vývojář', node: 'backend', input: 'Diffy obou pracovníků a kontrakty modulů', output: 'Integrovaná revize se seznamem změněných souborů', gate: 'Konflikty řešit se zachováním obou záměrů; znovu ověřit rozhraní.' },
  { id: 'proof', phase: '03 · Důkazy', title: 'Model ↔ implementace', owner: 'Kontrolor', node: 'checks', input: 'Oprava R-01 a protipříklad', output: 'Vazba invariant → implementace → regresní test', gate: 'Úspěch modelu není automaticky důkaz správnosti celého programu.' },
  { id: 'independent', phase: '03 · Důkazy', title: 'Nezávislé review', owner: 'Kontrolor', node: 'review', input: 'Aktuální diff, kontrakt a výsledky kontrol', output: 'Nálezy s prioritou, souborem a způsobem ověření', gate: 'Blokující nález vrací práci k opravě; žádné odhadované úspěchy.' },
  { id: 'simplify', phase: '03 · Důkazy', title: 'Zjednodušení a nové kontroly', owner: 'Vývojář + kontrolor', node: 'review', input: 'Prověřená implementace a návrhy zjednodušení', output: 'V demo scénáři beze změny kódu; doporučení pro samostatný PR', gate: 'Každá skutečná změna SHA ruší staré CI a review; vrátit se na kontroly.' },
  { id: 'package', phase: '04 · GitHub', title: 'Dokumentace a balíček PR', owner: 'Vývojář', node: 'pr', input: 'Ověřená revize, README a příslušná docs stránka', output: 'PR: problém, změna chování, testy, limity, vazba na OP-128', gate: 'Bez tajemství a nesouvisejících souborů; screenshot u vizuální změny.' },
  { id: 'ci', phase: '04 · GitHub', title: 'CI a závislosti PR', owner: 'GitHub / kontrolor', node: 'pr', input: 'Modelový PR #214 a jeho aktuální head', output: 'Povinné kontroly a graf navazujících změn', gate: 'UI a další modul čekají na kontrakt. Úspěch starého head nestačí.' },
  { id: 'queue', phase: '04 · GitHub', title: 'Fronta sloučení', owner: 'GitHub / člověk', node: 'merge', input: 'Schválení člověka, aktuální kontroly a vyřešené diskuse', output: 'Pořadí: kontrakt → UI → navazující moduly', gate: 'Po změně base znovu ověřit merge výsledek; závislý PR čeká.' },
  { id: 'release', phase: '05 · Doručení', title: 'Verzovaný artefakt', owner: 'Doručovací pipeline', node: 'merge', input: 'Potvrzení merge a výsledné SHA', output: 'Modelový release manifest a kandidát do stagingu', gate: 'Sloučení není nasazení. Artefakt musí odpovídat sloučené revizi.' },
  { id: 'smoke', phase: '05 · Doručení', title: 'Staging, smoke a rollback', owner: 'Kontrolor', node: 'checks', input: 'Kandidát a poslední funkční verze', output: 'Modelový smoke výsledek a popsaný návrat na předchozí verzi', gate: 'Ověřit start, reconnect a klíčový tok. Produkční rollout je samostatné rozhodnutí.' },
  { id: 'close', phase: '05 · Doručení', title: 'Uzavření karty Opory', owner: 'Plánovač', node: 'plan', input: 'Merge receipt, CI, smoke a otevřené follow-upy', output: 'Souhrn výsledků, zbývající rizika a návazné úkoly', gate: 'Metriky z diffů a běhů; počet řádků sám neříká kvalitu.' },
  { id: 'evaluate', phase: '06 · Paměť', title: 'Vyhodnocení přínosu', owner: 'Paměť + kontrolor', node: 'learn', input: 'Zkušenost M-024 použitá v OP-129', output: 'Návrh párového vyhodnocení s pamětí a bez ní', gate: 'Stejná sada úloh a podmínky; zatím žádný změřený nárůst kvality.' },
] as const;
export type PipelineId = typeof PIPELINE[number]['id'];
export function pipelineError(s: StudioState, id: string | undefined): string | undefined {
  const next = PIPELINE[s.pipeline.length];
  if (!next || next.id !== id) return 'Pipeline čeká na předchozí krok; opakování ani přeskočení není platné.';
  const eligible: Record<PipelineId, boolean> = {
    intake: s.nodes.plan.status === 'working', sources: s.memory === 'recalled', spec: s.accepted,
    baseline: s.accepted, worktrees: s.accepted, counterexample: s.nodes.office.status === 'done',
    integration: s.nodes.frontend.status === 'done' && s.nodes.backend.status === 'done',
    proof: s.repaired && s.checksRevision === s.revision,
    independent: s.checksRevision === s.revision, simplify: s.reviewRevision === s.revision,
    package: s.reviewRevision === s.revision, ci: s.prRevision === s.revision,
    queue: s.approvalRevision === s.revision, release: s.merged, smoke: s.merged,
    close: s.merged, evaluate: s.memory === 'reused',
  };
  return eligible[next.id] ? undefined : 'Chybí vstup nebo aktuální důkaz kroku pipeline.';
}
