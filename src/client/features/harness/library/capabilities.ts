import { h } from '../../../ui/dom';

/** The worker's commands in the order a card uses them. The browser runs none of them and probes nothing. */
const PHASES: [string, [string, string, string][]][] = [
  ['Před prací', [
    ['Doporučit výbavu', 'Navrhne prostředky pro typ úkolu, s důvody a změřenou zkušeností. Do karty ji zapíše až přijatý návrh.', 'office-harness --recommend PROBLEM'],
    ['Přečíst přijatou výbavu', 'Přesné prostředky, verze a oprávnění této karty. Pozdější úprava knihovny ji nezmění.', 'office-harness --accepted-kit'],
    ['Připravit výbavu', 'Ověří, že je výbava čitelná a podporovaná, a připraví ji před startem.', 'office-harness --prepare-accepted'],
    ['Ověřit runner', 'Co umí skutečně nainstalovaný runner. Položka v katalogu není důkaz, že nástroj poběží.', 'office-harness --probe'],
    ['Dokumentace (Context7)', 'Najde knihovnu a odpoví z její dokumentace ve správné verzi.', 'office-harness --docs-accepted RESOURCE "otázka"'],
  ]],
  ['Během práce', [
    ['Spustit připnutý skript', 'Spustí skript z výbavy (ES modul). Velký vstup předejte souborem v pracovní složce.', 'office-harness --invoke-node RESOURCE -- ARG …'],
    ['Sdílená zkušenost', 'Načte zkušenost publikovanou z jiného projektu (OpenViking).', 'office-harness --recall-shared PUBLICATION --resource RESOURCE'],
  ]],
  ['Po práci', [
    ['Zaznamenaná volání', 'Která volání nástrojů proběhla a s jakou verzí. Neměřené zůstává neznámé.', 'office-harness --invocations'],
    ['Nezávislé ověření', 'Požádá Oporu, aby přijatý párový plán ověřila v izolovaném kontejneru.', 'office-harness --verify-pair PLAN'],
    ['Stav verze nástroje', 'Povýšení, pozastavení a návrat na předchozí verzi, vždy s důkazem.', 'office-harness --tool-status PLAN'],
  ]],
];

export function capabilityCards() {
  return h('div.harness-phases', {}, ...PHASES.map(([phase, commands]) => h('section.harness-phase', { 'aria-label': phase },
    h('h4', {}, phase),
    h('div.harness-capability-grid', {}, ...commands.map(([name, what, command]) =>
      h('article.harness-capability', {}, h('strong', {}, name), h('p', {}, what), h('code', {}, command)))))));
}
