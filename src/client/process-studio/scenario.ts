import type { EventType, Repository, StudioEvent } from './model';
import { PIPELINE, type PipelineId } from './pipeline-model';

export interface Scene { type: EventType; message: string; node?: string; repositoryIds?: string[]; stage?: PipelineId }
function delivery(stage: PipelineId): Scene {
  const step = PIPELINE.find(step => step.id === stage)!;
  return { type: 'pipeline.observe', stage, message: `${step.title}: ${step.output}. ${step.gate}` };
}
export function scenario(repositories: Repository[]): Scene[] {
  return [
    { type: 'plan.draft', message: 'Opora vytváří kartu OP-128: cíl, rozsah, vlastníci a očekávaný výstup.' },
    delivery('intake'),
    { type: 'memory.recall', message: 'OpenViking předává dvě dřívější zkušenosti a zdrojový kontext.' },
    delivery('sources'),
    { type: 'plan.gap', message: 'Kontrola plánu našla mezeru: chybí popis a test obnovení spojení.' },
    { type: 'plan.refine', message: 'Plán roste do revize 2. Přibývá AC-03, jeho test a očekávaný výsledek.' },
    { type: 'plan.accept', message: 'Přijatý plán má pět podmínek dokončení, vlastníky a dohledatelné důkazy.' },
    delivery('spec'),
    ...repositories.flatMap(r => [
      { type: 'repo.inspect' as const, node: r.id, message: `${r.name}: zapracováváme zvolenou roli do modelového workflow.` },
      { type: 'repo.verified' as const, node: r.id, message: `${r.name}: vstup, výstup a kontrola rozhraní jsou součástí plánu.` },
    ]),
    delivery('baseline'), delivery('worktrees'),
    { type: 'work.assign', message: 'Kancelář přiděluje dvě oddělené větve pracovníkům. Každý dostává stejnou revizi plánu.' },
    delivery('counterexample'),
    { type: 'work.start', node: 'frontend', message: 'Vývojář začíná UI průběhu. Změna patří OP-128 / revizi 2.' },
    { type: 'work.start', node: 'backend', message: 'Druhý pracovník souběžně připravuje zpracování událostí a obnovu stavu.' },
    { type: 'work.complete', node: 'frontend', message: 'UI má modelový diff a hotové soubory. Správnost ještě nepotvrdily kontroly.' },
    { type: 'work.complete', node: 'backend', message: 'Obě větve předávají výstupy. Začíná společná kontrola smluveného chování.' },
    delivery('integration'),
    { type: 'checks.start', message: 'Spouštíme typovou kontrolu, testy a sestavení vůči přijatému plánu.' },
    { type: 'checks.fail', message: 'Zachycena chyba AC-02: duplicitní událost vytvořila druhý výsledek. Předání je zastaveno.' },
    { type: 'repair.plan', message: 'Workflow se rozšiřuje o opravu R-01. Revize 3 zneplatňuje staré kontroly.' },
    { type: 'plan.accept', message: 'Revize 3 s opravou R-01 je v modelovém scénáři znovu přijata.' },
    { type: 'repair.start', message: 'Pavouk vývojáře se vrací k opravě. Doplňuje deduplikaci a regresní případ.' },
    { type: 'repair.complete', message: 'Oprava je připravená. Výsledek musí projít novými kontrolami.' },
    { type: 'checks.start', message: 'Nový běh ověřuje revizi 3 a rozhraní všech připojených modulů.' },
    { type: 'checks.pass', repositoryIds: repositories.map(r => r.id), message: '42/42 modelových testů prošlo; typy i sestavení jsou v pořádku pro aktuální revizi.' },
    delivery('proof'), delivery('independent'),
    { type: 'review.pass', message: 'Kontrolor propojuje podmínky plánu, změněné soubory a výsledky kontrol.' },
    delivery('simplify'), delivery('package'),
    { type: 'pr.open', message: 'Ukázkový PR #214 obsahuje diff, testy a vazby na kartu i související repozitáře.' },
    delivery('ci'),
    { type: 'human.wait', message: 'Vše je připravené k revizi člověkem. Ukázka pokračuje až po vašem rozhodnutí.' },
    delivery('queue'),
    { type: 'merge.confirm', message: 'Modelové sloučení je potvrzené. Opora připojuje výsledek ke kartě.' },
    delivery('release'), delivery('smoke'), delivery('close'),
    { type: 'memory.propose', message: 'Z doložené opravy vzniká kandidát zkušenosti M-024 se zdroji a změnou obsahu.' },
    { type: 'memory.persist', message: 'Přichází modelové potvrzení zápisu M-024. Zkušenost je připravená pro další úkol.' },
    { type: 'memory.reuse', message: 'Úkol OP-129 znovu načítá M-024. Vidíme použití paměti; zlepšení kvality zatím není změřené.' },
    delivery('evaluate'),
    { type: 'run.finish', message: 'Průchod dokončen: plán → práce → oprava → důkazy → výsledek → opětovně použitá zkušenost.' },
  ];
}
export function eventFor(scene: Scene, run: string, sequence: number): StudioEvent {
  return { ...scene, run, sequence, id: `${run}:${sequence}` };
}
