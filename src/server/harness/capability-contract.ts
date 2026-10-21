// The capabilities section of a worker's contract (docs/harness.md "Runner adapters and capabilities"):
// what the run's adapters made and proved. Only `verified` capabilities are offered as available; a
// `declared` or `prepared` one is listed with its state and why, and is never presented as ready.
import type { Capability } from './adapters.js';

const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

export function capabilitySection(capabilities: readonly Capability[]): string {
  const ready = capabilities.filter((c) => c.state === 'verified');
  const not = capabilities.filter((c) => c.state !== 'verified');
  const line = (c: Capability) => `  - ${clean(c.id)} (${clean(c.adapter)}): ${clean(c.detail)}`;
  return `\n\nRunner capabilities for this run (checked by the office, not claimed):
- Available (verified):
${ready.length ? ready.map(line).join('\n') : '  - none'}
- Not available, do not rely on them (state and reason):
${not.length ? not.map((c) => `  - ${clean(c.id)} (${clean(c.adapter)}) · ${c.state}: ${clean(c.detail)}`).join('\n') : '  - none'}
- Anything not listed here (another MCP server, a permission you lack) is not set up for you: report it in agent-output errors rather than configuring it yourself.`;
}
