import { pipelineState } from './classify.js';
import { record } from './source.js';

/** Conservative mirror of Opora completion_evidence.py, card_checks.py and state.save gates.
 * No claim that reported evidence has been independently verified. Opora rechecks on save.
 */
export function completionBlockers(value: unknown): string[] {
  const b = record(value), n = record(b?.node), loop = record(b?.loop);
  const evidence = record(b?.evidence);
  const missing: string[] = [];
  if (b?.readOnly !== false) missing.push('Pracovní prostor není ověřen jako zapisovatelný.');
  if (!n || typeof n.name !== 'string') missing.push('Chybí údaje karty pro ověření podmínek.');
  const pipeline = pipelineState(b);
  if (pipeline !== 'complete') {
    const stages = record(b?.pipeline)?.stages;
    const pending = Array.isArray(stages) ? stages.map(record).filter((s) => s && !['passed', 'skipped'].includes(String(s.status))).map((s) => String(s!.title || s!.id)) : [];
    missing.push(pipeline === 'unknown' ? 'Stav etap se nepodařilo ověřit.' : `Nedokončené etapy: ${pending.join(', ') || 'viz pipeline karty'}.`);
  }
  if (loop?.openBlocks !== 0) missing.push('Bloky karty nejsou všechny ověřeny jako splněné.');
  if (!Array.isArray(loop?.waitingOnHuman) || loop.waitingOnHuman.length) missing.push('Nejsou vyřešeny nebo ověřeny všechny požadavky na člověka.');
  if (Array.isArray(b?.blocks) && b.blocks.some((block) => record(record(block)?.state)?.status !== 'met')) missing.push('Některý blok včetně bezpečnosti vstupu není splněný.');
  const strict = String(n?.name ?? '').startsWith('[task] ') || (Array.isArray(n?.checks) && n.checks.length > 0);
  for (const [key, label] of [['tests', 'Testy'], ['review', 'Review'], ['merge', 'Merge']] as const) {
    const proof = record(evidence?.[key]);
    if (proof?.status === 'not_applicable') {
      if ((strict && key !== 'review') || typeof proof.note !== 'string' || !proof.note.trim()) missing.push(`${label}: nelze použít N/A bez povoleného a zdůvodněného vynechání.`);
    } else if (proof?.status !== 'passed') missing.push(`${label}: chybí úspěšný doklad.`);
    else if (key !== 'tests' && (typeof proof.url !== 'string' || !proof.url.trim())) missing.push(`${label}: chybí odkaz na doklad.`);
  }
  const rawRuns = evidence?.checksRun;
  const runs = Array.isArray(rawRuns) ? rawRuns.map(record) : [];
  if (!Array.isArray(rawRuns) || runs.length > 200 || new Set(runs.map((r) => r?.checkId)).size !== runs.length || (!runs.length && record(evidence?.tests)?.status !== 'not_applicable') ||
    runs.some((r) => !r || r.exitCode !== 0 || typeof r.command !== 'string' || !r.command.trim() || typeof r.checkId !== 'string' || !r.checkId ||
      typeof r.at !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(r.at) || !Number.isFinite(Date.parse(r.at)))) {
    missing.push('Běhy kontrol: chybí úplné záznamy příkazů s úspěšným výsledkem a časem.');
  }
  if (n?.checks !== undefined && !Array.isArray(n.checks)) missing.push('Předepsané kontroly se nepodařilo načíst.');
  for (const value of Array.isArray(n?.checks) ? n.checks : []) {
    const check = record(value);
    if (!check || typeof check.id !== 'string' || typeof check.command !== 'string' || !runs.some((r) => r && r.checkId === check.id && r.command === check.command && r.exitCode === 0)) {
      missing.push(`Předepsaná kontrola ${String(check?.id ?? '?')}: chybí úspěšný běh se shodným ID a příkazem.`);
    }
  }
  if (n?.scenario !== undefined) {
    const scenario = record(n.scenario), run = record(b?.scenarioRun);
    if (typeof scenario?.command !== 'string' || !scenario.command || run?.command !== scenario.command || run.failed !== 0) missing.push('Scénář brány: chybí úspěšný běh aktuálního příkazu.');
  }
  return missing;
}
