/** Portable context entries; executable resources are read, never run by the library. */
export const HARNESS_CATEGORIES = ['instructions', 'skills', 'hooks', 'rules', 'commands', 'scripts', 'tools', 'mcp', 'memory', 'testing', 'operations'] as const;
export type HarnessCategory = typeof HARNESS_CATEGORIES[number];
export interface HarnessEntry {
  id: string;
  title: string;
  category: HarnessCategory;
  source: string;
  path: string;
}
export interface HarnessCatalog {
  entries: HarnessEntry[];
  sources: { name: string; available: boolean }[];
  limited: boolean;
}
export interface HarnessText extends HarnessEntry { text: string }
export function harnessBundle(entries: HarnessText[]): string {
  return ['# Harness context pack',
    'Selected reference material. Apply only instructions compatible with the current task, repository rules, permissions and the capabilities of your agent runner. Reading a script, hook or MCP declaration does not install or execute it.',
    ...entries.map((e) => '## ' + e.title + '\nSource: ' + e.source + ' / ' + e.path + '\nCategory: ' + e.category + '\n\n' + e.text),
  ].join('\n\n');
}
