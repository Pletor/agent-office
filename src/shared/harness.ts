/** Portable context entries; executable resources are read, never run by the library. */
export const HARNESS_CATEGORIES = ['instructions', 'skills', 'hooks', 'rules', 'commands', 'scripts', 'tools', 'mcp', 'memory', 'plugins', 'permissions', 'testing', 'operations'] as const;
export type HarnessCategory = typeof HARNESS_CATEGORIES[number];
/** What each category is for, in one line: the header/tooltip of the category in the library. */
export const HARNESS_CATEGORY_PURPOSE: Readonly<Record<HarnessCategory, string>> = {
  instructions: 'Task framing, repository rules of the road and start-here guidance a model reads first.',
  skills: 'Reusable procedures (SKILL.md and supporting files) a runner can discover and apply to a task.',
  hooks: 'Lifecycle scripts a runner executes around sessions and tool calls; read before enabling.',
  rules: 'Narrow, observable constraints and precedence rules that shape how work is done.',
  commands: 'Named, repeatable workflows and slash commands with documented inputs and outputs.',
  scripts: 'Runbooks and helper scripts; displayed as text, inspected before any execution.',
  tools: 'Tool contracts, capability checks and fallbacks for filesystem, shell, search and browsers.',
  mcp: 'MCP server declarations and verification steps; a declaration is not a connected server.',
  memory: 'Recall and persistence references (OpenViking and sanitized memory exports).',
  plugins: 'Runner plugins and bundles that package skills, hooks and MCP together; reference only.',
  permissions: 'Permission policies and allow/deny lists a runner enforces; never granted by this library.',
  testing: 'Evaluations, regression proof and acceptance conditions for changed behaviour.',
  operations: 'Context budgets, checkpoints, handoff and escalation procedures.',
};
export interface HarnessEntry {
  /** Local installation ID, stable across restarts and checkout moves (docs/harness.md "Element IDs"). */
  id: string;
  title: string;
  category: HarnessCategory;
  /** Sub-grouping inside the category: the folder the element sits in, so a category reads as a shelf, not a heap. */
  group: string;
  source: string;
  path: string;
  /** Per-element revision from the installation registry; 0 when no registry is attached (CLI without a data dir). */
  version: number;
  /** SHA-256 of the content as last listed, hex. */
  digest: string;
  /** Older IDs this element was known by; they keep resolving (compatibility aliases). */
  aliases: string[];
}
export interface HarnessCatalog {
  entries: HarnessEntry[];
  sources: { name: string; available: boolean }[];
  limited: boolean;
}
/**
 * A defined thing in the library (docs/harness-items.md): what it is, what triggers it, what runs
 * deterministically and which files it is made of. It lives in a `*.item.json` next to its parts.
 */
export interface HarnessItem {
  schema: 'harness.item/1';
  kind: 'skill' | 'hook' | 'script' | 'command';
  name: string; summary: string; when?: string;
  /** Hooks only: the runner event, and for tool events the tool it matches. */
  trigger?: { event: string; matcher?: string };
  /** What runs: always a pinned part, never a free command line. */
  run?: { runner: 'node'; entry: string; args: string[] };
  parts: { path: string; role: 'instructions' | 'reference' | 'script' | 'example' | 'asset' }[];
  deterministic: boolean; outputs?: string; verify?: string;
}
/** A definition as read: parsed with its parts resolved to catalog entries, or why it is refused. */
export type HarnessItemView =
  | { definition: HarnessItem; parts: { path: string; role: string; id: string; title: string; category: HarnessCategory }[] }
  | { error: string };
export interface HarnessText extends HarnessEntry { text: string; item?: HarnessItemView }
/**
 * How an ID resolves against the library: present; known to the installation but not available here
 * (a tombstone when `missingSince` is set, otherwise an element of another project); or never seen.
 */
export type HarnessResolution =
  | { status: 'available'; entry: HarnessEntry }
  | { status: 'missing'; id: string; title: string; path: string; source: string; category: HarnessCategory; version: number; revision: number; digest: string; lastSeenAt: string; missingSince: string }
  | { status: 'unknown'; id: string };
export function harnessBundle(entries: HarnessText[]): string {
  return ['# Harness context pack',
    'Selected reference material. Apply only instructions compatible with the current task, repository rules, permissions and the capabilities of your agent runner. Reading a script, hook or MCP declaration does not install or execute it.',
    ...entries.map((e) => '## ' + e.title + '\nSource: ' + e.source + ' / ' + e.path + '\nCategory: ' + e.category + '\nElement: ' + e.id + ' · revision ' + e.version + ' · sha256:' + e.digest + '\n\n' + e.text),
  ].join('\n\n');
}
