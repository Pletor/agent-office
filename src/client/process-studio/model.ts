import { PIPELINE, pipelineError, type PipelineId } from './pipeline-model';
/** Deterministic, browser-only demonstration. No provider or repository mutations. */
export type Status = 'queued' | 'working' | 'done' | 'blocked' | 'failed';
export type RepoRole = 'context' | 'module' | 'check';
export interface Repository { id: string; name: string; url: string; role: RepoRole }
export interface NodeState { status: Status; detail: string }
export interface Evidence { id: string; node: string; title: string; detail: string; revision: number }
export interface StudioState {
  run: string; sequence: number; revision: number; accepted: boolean;
  missing: string[]; repositories: Repository[]; nodes: Record<string, NodeState>;
  checksRevision: number; reviewRevision: number; prRevision: number; approvalRevision: number;
  repaired: boolean; repairRequired: boolean; waiting: boolean; merged: boolean; finished: boolean;
  memory: 'empty' | 'recalled' | 'proposed' | 'persisted' | 'reused';
  evidence: Evidence[]; seen: string[]; headline: string; active: string; actor: string;
  pipeline: PipelineId[];
}
export type EventType = 'plan.draft' | 'memory.recall' | 'plan.gap' | 'plan.refine' | 'plan.accept'
  | 'repo.inspect' | 'repo.verified' | 'work.assign' | 'work.start' | 'work.complete'
  | 'checks.start' | 'checks.fail' | 'repair.plan' | 'repair.start' | 'repair.complete'
  | 'checks.pass' | 'review.pass' | 'pr.open' | 'human.wait' | 'human.approve'
  | 'merge.confirm' | 'memory.propose' | 'memory.persist' | 'memory.reuse' | 'run.finish' | 'pipeline.observe';
export interface StudioEvent {
  id: string; run: string; sequence: number; type: EventType; message: string;
  node?: string; repositoryIds?: string[];
  stage?: PipelineId;
}
export const BASE_NODES = ['plan', 'context', 'recall', 'contract', 'office', 'frontend', 'backend', 'checks', 'learn', 'merge', 'pr', 'review'];
export const ROLE_LABELS: Record<RepoRole, string> = { context: 'Zdroj kontextu', module: 'Vývojový modul', check: 'Kontrolní služba' };
export const ROLE_CONTRACTS: Record<RepoRole, { input: string; output: string; check: string }> = {
  context: { input: 'Dotaz, rozsah úkolu a revize zdrojů', output: 'Vybrané zdroje s původem předané do kontextu', check: 'Relevantnost zdrojů, dostupnost a dohledatelná verze' },
  module: { input: 'Přijatá karta, datové rozhraní a závislosti', output: 'Změna v izolované větvi a verzovaný výstup modulu', check: 'Test rozhraní, regrese a kompatibilita s navazujícími kroky' },
  check: { input: 'Konkrétní změna a aktuální revize podmínek', output: 'Výsledek kontroly se stavem a odkazem na důkaz', check: 'Povinný úspěšný výsledek pro stejný rozsah a revizi' },
};
export const REQUIREMENTS = [
  { id: 'AC-01', title: 'Každý krok patří ke kartě a revizi plánu', proof: 'Test vazby taskId + planRevision', owner: 'Plánovač + backend', expected: 'Každá událost nese OP-128 a revizi svého zadání.' },
  { id: 'AC-02', title: 'Dvojí událost nevytvoří druhý výsledek', proof: 'Regresní test opakované události', owner: 'Backend', expected: 'Dvě doručení stejného eventId vytvoří právě jeden záznam.' },
  { id: 'AC-03', title: 'Obnovení spojení zachová skutečný stav', proof: 'Test obnovy ze snapshotu a událostí', owner: 'Frontend + backend', expected: 'Snapshot s následnými událostmi dává stejný stav jako souvislý běh.' },
  { id: 'AC-04', title: 'Změna plánu zneplatní staré kontroly', proof: 'Test kontroly vůči aktuální revizi', owner: 'Kontrolor', expected: 'Kontrola revize 2 nesmí umožnit předání revize 3.' },
  { id: 'AC-05', title: 'Výsledek má testy, revizi a potvrzené sloučení', proof: 'Kontroly + review + receipt GitHubu', owner: 'Kontrolor + člověk', expected: 'Karta má aktuální důkazy a samostatné potvrzení sloučení.' },
];
export function initialState(repositories: Repository[] = [], run = 'DEMO-042'): StudioState {
  return {
    run, sequence: 0, revision: 1, accepted: false, missing: ['AC-03'], repositories: structuredClone(repositories),
    nodes: Object.fromEntries([...BASE_NODES, ...repositories.map(r => r.id)].map(id => [id, { status: 'queued', detail: 'Čeká na vstup' }])),
    checksRevision: 0, reviewRevision: 0, prRevision: 0, approvalRevision: 0,
    repaired: false, repairRequired: false, waiting: false, merged: false, finished: false,
    memory: 'empty', evidence: [], seen: [], pipeline: [], headline: 'Připravujeme kartu Opory a první verzi plánu.', active: 'plan', actor: 'planner',
  };
}
export function readyForReview(s: StudioState): boolean {
  return s.accepted && s.checksRevision === s.revision && s.nodes.frontend.status === 'done'
    && s.nodes.backend.status === 'done' && (!s.repairRequired || s.repaired);
}
export function canMerge(s: StudioState): boolean {
  return readyForReview(s) && s.reviewRevision === s.revision && s.prRevision === s.revision && s.approvalRevision === s.revision;
}
function invalidate(s: StudioState) {
  s.revision++; s.accepted = false; s.checksRevision = s.reviewRevision = s.prRevision = s.approvalRevision = 0;
  s.waiting = false;
  for (const id of ['checks', 'review', 'pr', 'merge']) s.nodes[id] = { status: 'queued', detail: 'Vyžaduje novou revizi důkazu' };
}
/** Reject duplicates, out-of-order observations and unsupported transitions before changing state. */
export function reduceEvent(previous: StudioState, event: StudioEvent): { state: StudioState; error?: string } {
  const reject = (error: string) => ({ state: previous, error });
  if (event.run !== previous.run) return reject('Událost patří jinému běhu.');
  if (previous.seen.includes(event.id)) return reject('Duplicitní událost byla ignorována.');
  if (event.sequence !== previous.sequence + 1) return reject('Chybí předchozí událost.');
  if (previous.finished) return reject('Běh je již dokončen.');
  const s = structuredClone(previous);
  const node = (id: string, status: Status, detail: string) => { s.nodes[id] = { status, detail }; s.active = id; };
  const proof = (id: string, title: string, detail: string) => s.evidence.push({ id: event.id, node: id, title, detail, revision: s.revision });
  const workersDone = s.nodes.frontend.status === 'done' && s.nodes.backend.status === 'done';
  switch (event.type) {
    case 'pipeline.observe': {
      const error = pipelineError(s, event.stage);
      if (error) return reject(error);
      const step = PIPELINE.find(step => step.id === event.stage)!;
      s.pipeline.push(step.id); s.active = step.node;
      s.actor = step.owner.includes('Paměť') ? 'memory' : step.owner.includes('Kontrolor') ? 'reviewer' : step.owner.includes('Plánovač') ? 'planner' : 'developer';
      proof(step.node, step.title, `Modelové předání. Vstup: ${step.input}. Výstup: ${step.output}. Podmínka: ${step.gate}`); break;
    }
    case 'plan.draft':
      if (s.sequence !== 0) return reject('Plán už existuje.');
      node('plan', 'working', 'OP-128 · revize 1'); s.actor = 'planner';
      proof('plan', 'Zadání OP-128', 'Cíl: dohledatelný průběh práce napříč Oporou, kanceláří a GitHubem. Výstup: otestovaná změna a propojené PR.'); break;
    case 'memory.recall':
      if (s.nodes.plan.status === 'queued') return reject('Nejdříve je potřeba zadání.');
      node('context', 'done', '3 zdroje · původ dohledán'); node('recall', 'done', '2 zkušenosti načteny'); s.memory = 'recalled'; s.actor = 'memory';
      proof('recall', 'Načtený kontext', 'M-017: při reconnectu obnov snapshot. M-023: klíč události musí být idempotentní. Zdroj: dva dřívější modelové běhy; vyhledáno a předáno do kontextu.'); break;
    case 'plan.gap':
      node('contract', 'blocked', 'Chybí AC-03'); s.actor = 'planner';
      proof('contract', 'Mezera v plánu', 'Není popsáno chování po přerušení spojení. Bez očekávaného výsledku a testu nelze předat práci.'); break;
    case 'plan.refine':
      if (s.nodes.contract.status !== 'blocked') return reject('Plán nemá identifikovanou mezeru.');
      invalidate(s); s.missing = []; node('plan', 'working', `Doplněna revize ${s.revision}`); node('contract', 'working', '5 podmínek + důkazy');
      proof('plan', 'Doplněný plán', 'AC-03: reconnect obnoví snapshot, následné události se aplikují právě jednou. Přidán test obnovy, vlastník a výstup kroku.'); break;
    case 'plan.accept':
      if (s.missing.length) return reject('Plánu chybí podmínky dokončení.');
      s.accepted = true; s.actor = 'planner'; node('plan', 'done', `Přijata revize ${s.revision}`); node('contract', 'done', '5/5 podmínek popsáno'); break;
    case 'repo.inspect':
    case 'repo.verified': {
      if (!s.accepted || !s.repositories.some(r => r.id === event.node)) return reject('Repozitář není v přijatém plánu.');
      const r = s.repositories.find(r => r.id === event.node)!;
      node(r.id, event.type === 'repo.inspect' ? 'working' : 'done', event.type === 'repo.inspect' ? 'Příprava rozhraní v modelu' : 'Rozhraní zahrnuto do plánu');
      s.actor = 'planner';
      const contract = ROLE_CONTRACTS[r.role];
      if (event.type === 'repo.verified') proof(r.id, `${r.name} · ${ROLE_LABELS[r.role]}`, `Modelové rozhraní. Vstup: ${contract.input}. Výstup: ${contract.output}. Kontrola: ${contract.check}. Repozitář nebyl stažen ani kontaktován.`);
      break;
    }
    case 'work.assign':
      if (!s.pipeline.includes('worktrees')) return reject('Chybí výchozí stav a izolované pracovní větve.');
      if (!s.accepted || s.repositories.some(r => s.nodes[r.id].status !== 'done')) return reject('Nejsou připravené všechny části plánu.');
      node('office', 'done', '2 pracovníci · 2 worktrees'); s.actor = 'developer'; break;
    case 'work.start':
    case 'work.complete': {
      if (!s.pipeline.includes('counterexample')) return reject('Nejdříve připravte reprodukci a očekávané chování.');
      if (!s.accepted || s.nodes.office.status !== 'done' || !['frontend', 'backend'].includes(event.node ?? '')) return reject('Práci nelze přidělit.');
      const id = event.node!;
      if (event.type === 'work.complete' && s.nodes[id].status !== 'working') return reject('Práce ještě nezačala.');
      node(id, event.type === 'work.start' ? 'working' : 'done', event.type === 'work.start' ? 'Izolovaná větev · běží' : 'Změna připravena ke kontrole');
      s.actor = id === 'frontend' ? 'developer' : 'reviewer';
      if (event.type === 'work.complete') proof(id, 'Změny přiřazené ke kartě', `${id}: modelový diff a seznam změněných souborů. Vazba: OP-128 / revize ${s.revision}. Konec práce není důkazem správnosti.`); break;
    }
    case 'checks.start':
      if (!s.pipeline.includes('integration')) return reject('Kontroly vyžadují integrovanou změnu.');
      if (!s.accepted || !workersDone || (s.repairRequired && !s.repaired)) return reject('Kontroly čekají na dokončené změny.');
      node('checks', 'working', 'typecheck · test · build'); s.actor = 'reviewer'; break;
    case 'checks.fail':
      if (s.nodes.checks.status !== 'working') return reject('Kontroly neběží.');
      node('checks', 'failed', 'AC-02: dvojí událost'); s.checksRevision = 0;
      proof('checks', 'Regrese zachycena', 'Opakované doručení eventId vytvořilo druhý výsledek. Očekáváno 1, obdrženo 2. Předání je blokováno.'); break;
    case 'repair.plan':
      if (s.nodes.checks.status !== 'failed') return reject('Chybí selhání, které opravujeme.');
      invalidate(s); s.repairRequired = true; s.repaired = false; s.actor = 'planner';
      node('repair', 'queued', 'Nový krok plánu: deduplikace'); node('plan', 'working', `Revize ${s.revision} · oprava AC-02`);
      proof('plan', 'Workflow rozšířeno', 'Přidán krok R-01: deduplikovat eventId, pokrýt opakované doručení a zopakovat všechny kontroly. Staré výsledky kontrol jsou neplatné.'); break;
    case 'repair.start':
      if (!s.accepted || !s.repairRequired) return reject('Oprava není přijata v plánu.');
      node('repair', 'working', 'R-01 · oprava idempotence'); s.actor = 'developer'; break;
    case 'repair.complete':
      if (s.nodes.repair?.status !== 'working') return reject('Oprava neběží.');
      s.repaired = true; node('repair', 'done', 'Opraveno · čeká na test');
      proof('repair', 'Oprava R-01', 'Přidána kontrola eventId a regresní případ pro duplicitní doručení. Správnost musí potvrdit nový běh kontrol.'); break;
    case 'checks.pass':
      if (!s.accepted || s.nodes.checks.status !== 'working' || !workersDone || (s.repairRequired && !s.repaired)) return reject('Chybí platný běh kontrol.');
      if (s.repositories.some(r => !event.repositoryIds?.includes(r.id))) return reject('Kontroly nepokrývají přidané repozitáře.');
      s.checksRevision = s.revision; node('checks', 'done', '42/42 · typy ✓ · build ✓');
      proof('checks', 'Kontroly aktuální revize', `Modelový výsledek: 42 testů prošlo, typecheck i build exit 0. AC-01 až AC-04 pokryty. Rozšíření: ${s.repositories.map(r => r.name).join(', ') || 'žádné'}.`); break;
    case 'review.pass':
      if (!s.pipeline.includes('independent')) return reject('Chybí nezávislé review implementace.');
      if (!readyForReview(s)) return reject('Review vyžaduje platné kontroly.');
      s.reviewRevision = s.revision; node('review', 'done', 'Plán ↔ změny ↔ důkazy'); s.actor = 'reviewer';
      proof('review', 'Revize výsledku', 'Kontrolor porovnal změnu s AC-01 až AC-05. Důkazy patří aktuální revizi plánu. Sloučení zbývá potvrdit.'); break;
    case 'pr.open':
      if (!s.pipeline.includes('package')) return reject('Chybí dokumentace a balíček předání.');
      if (!readyForReview(s) || s.reviewRevision !== s.revision) return reject('PR čeká na kontroly a review.');
      s.prRevision = s.revision; node('pr', 'done', 'Ukázkový PR #214'); s.actor = 'developer';
      proof('pr', 'PR #214 · modelový záznam', `OP-128 / revize ${s.revision}. Diff, testy, omezení a odkazy na související repozitáře jsou připojené.`); break;
    case 'human.wait':
      if (!s.pipeline.includes('ci')) return reject('Čekáme na kontroly publikovaného PR.');
      if (s.prRevision !== s.revision) return reject('Chybí aktuální PR.');
      s.waiting = true; node('merge', 'blocked', 'Čeká na vaše rozhodnutí'); break;
    case 'human.approve':
      if (!s.waiting || !readyForReview(s) || s.reviewRevision !== s.revision || s.prRevision !== s.revision) return reject('Nelze schválit neověřený výsledek.');
      s.approvalRevision = s.revision; s.waiting = false; node('merge', 'working', 'Schváleno v ukázce');
      proof('merge', 'Rozhodnutí člověka', 'Uživatel schválil pokračování modelového běhu. Žádný skutečný pull request se neslučuje.'); break;
    case 'merge.confirm':
      if (!s.pipeline.includes('queue')) return reject('Chybí vyhodnocení fronty a závislostí.');
      if (!canMerge(s)) return reject('Sloučení vyžaduje aktuální důkazy a rozhodnutí.');
      s.merged = true; node('merge', 'done', 'Potvrzené sloučení · demo');
      proof('merge', 'Receipt sloučení', 'Modelový GitHub receipt: PR #214 sloučen do main; výsledek připojen ke kartě OP-128.'); break;
    case 'memory.propose':
      if (!s.pipeline.includes('close')) return reject('Chybí výsledný souhrn doručení v Opoře.');
      if (!s.merged) return reject('Zkušenost potřebuje doložený výsledek.');
      s.memory = 'proposed'; s.actor = 'memory'; node('learn', 'working', 'Kandidát M-024 · původ OP-128');
      proof('learn', 'Návrh zkušenosti', 'PŘED: deduplikuj eventId. PO: deduplikuj eventId i při obnově po reconnectu; ověř kombinaci snapshot + opakovaný event. Zdroj: AC-02, AC-03, R-01 a nový běh kontrol.'); break;
    case 'memory.persist':
      if (s.memory !== 'proposed') return reject('Chybí kandidát paměti.');
      s.memory = 'persisted'; node('learn', 'done', 'M-024 uložena · modelově');
      proof('learn', 'Potvrzení paměti', 'Ukázkové potvrzení zápisu M-024 s odkazem na OP-128. Samotné odeslání session by ještě nepotvrzovalo dokončení asynchronního zpracování.'); break;
    case 'memory.reuse':
      if (s.memory !== 'persisted') return reject('Zkušenost ještě není uložena.');
      s.memory = 'reused'; node('recall', 'done', 'M-024 načtena pro OP-129');
      proof('recall', 'Opětovné použití', 'Nový modelový úkol OP-129 dostal M-024 do kontextu. Přínos zatím nebyl změřen srovnávacím vyhodnocením.'); break;
    case 'run.finish':
      if (!s.pipeline.includes('evaluate')) return reject('Chybí plán vyhodnocení přínosu paměti.');
      if (!s.merged || s.memory !== 'reused') return reject('Průchod ještě není úplný.');
      s.finished = true; break;
    default: return reject('Neznámý typ události.');
  }
  s.sequence = event.sequence; s.seen.push(event.id); s.headline = event.message;
  return { state: s };
}
export function parseRepository(raw: string, role: string, existing: Repository[]): Repository {
  if (!['context', 'module', 'check'].includes(role)) throw new Error('Vyberte roli repozitáře.');
  if (existing.length >= 4) throw new Error('Ukázka pojme nejvýše čtyři další repozitáře.');
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Použijte HTTPS adresu github.com/vlastník/repozitář.');
  const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some(p => !/^[\w.-]+$/.test(p) || p === '.' || p === '..')) throw new Error('Zadejte přesnou adresu repozitáře bez dalších cest.');
  const canonical = `https://github.com/${parts.join('/')}`;
  if (existing.some(r => r.url.toLowerCase() === canonical.toLowerCase())) throw new Error('Tento repozitář už je zahrnutý.');
  return { id: `repo-${existing.length + 1}`, name: parts.join('/'), url: canonical, role: role as RepoRole };
}
