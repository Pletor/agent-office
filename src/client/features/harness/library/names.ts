import type { HarnessCategory } from '../../../../shared/harness';

/** The library's Czech names of the categories; the IDs stay the catalog's own. */
export const CATEGORY_NAMES: Readonly<Record<HarnessCategory, string>> = {
  instructions: 'Instrukce', skills: 'Skills', hooks: 'Hooky', rules: 'Pravidla', commands: 'Příkazy', scripts: 'Skripty',
  tools: 'Nástroje', mcp: 'MCP', memory: 'Paměť', plugins: 'Pluginy', permissions: 'Oprávnění', testing: 'Testování', operations: 'Provoz',
};

/** What a category holds, in one line a person and an agent both read the same way. */
export const CATEGORY_HINTS: Readonly<Record<HarnessCategory, string>> = {
  instructions: 'Co si agent přečte jako první: zadání, pravidla repozitáře, začni tady.',
  skills: 'Opakovatelné postupy (SKILL.md), které agent najde a použije.',
  hooks: 'Skripty kolem relace a volání nástrojů; před zapnutím je přečtěte.',
  rules: 'Úzká, ověřitelná pravidla a jejich přednost.',
  commands: 'Pojmenované postupy a slash příkazy se vstupy a výstupy.',
  scripts: 'Runbooky a pomocné skripty; knihovna je jen ukazuje, nespouští.',
  tools: 'Smlouvy nástrojů, kontrola schopností a záložní cesty.',
  mcp: 'Deklarace MCP serverů; deklarace ještě není připojený server.',
  memory: 'Odkazy na paměť (OpenViking, exporty zkušeností).',
  plugins: 'Balíčky pluginů se skills, hooky a MCP; jen odkaz.',
  permissions: 'Zásady oprávnění, které vynucuje runner; knihovna nic nepovoluje.',
  testing: 'Testy, důkaz bez regrese a podmínky přijetí.',
  operations: 'Rozpočet kontextu, checkpointy, předání a eskalace.',
};

export const categoryName = (category: string) => CATEGORY_NAMES[category as HarnessCategory] ?? category;
