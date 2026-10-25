import { h } from '../../../ui/dom';

/** Describes existing worker contracts, without claiming that this browser has probed them. */
const CONTRACTS = [
  ['Accepted runtime', 'Pinned kit → exact resources, versions and permissions', 'Read the current execution’s immutable kit, then prepare its supported adapters. Editing a profile affects future preparation, not that accepted kit.', 'office-harness --accepted-kit'],
  ['Runner capabilities', 'Installed runner → bounded capability observations', 'Probe the authenticated worker’s actual runner. A catalog entry or a configured requirement alone is not proof that a tool can execute.', 'office-harness --probe'],
  ['Context7 documentation', 'Library + question → sourced documentation', 'Resolve a documentation library and query it through the worker endpoint. Accepted queries use the pinned documentation grant. Availability and credentials must be checked in that worker.', 'office-harness --docs-accepted RESOURCE "question"'],
  ['Invocation measurements', 'Execution + resource → recorded invocations', 'Inspect scoped invocation evidence, including resource versions and failures. Selected, prepared and invoked are different states; absent measurements remain unknown.', 'office-harness --invocations'],
  ['Office MCP', 'Accepted execution → allowed MCP tools', 'Expose the accepted tool surface through Office MCP. The runner must connect its authenticated MCP transport; reading a declaration does not establish that connection.', 'office-harness --accepted-kit'],
  ['Paired evaluations', 'Pinned baseline + candidate + fixture → paired evidence', 'Compare exact versions on controlled fixtures. Retain sample sizes, unknown outcomes and the fixture scope. Fixture performance does not establish production benefit.', 'office-harness --evaluate-pair PLAN_RESOURCE'],
  ['Learning and recovery', 'Native outcomes + history → bounded recommendations', 'Recommendations, exact-version withdrawal and compatible historical recovery retain their evidence and lifecycle checks. A recommendation never silently promotes a tool.', 'office-harness --recover RESOURCE --from EXECUTION'],
  ['Shared memory', 'Explicit publication + accepted resource → recall / publish', 'Shared Harness publications require their native authorization. OpenViking reference files are separate from a connected live memory service.', 'office-harness --recall-shared PUBLICATION --resource RESOURCE'],
  ['Tool lifecycle', 'Plan + expected revision → guarded lifecycle transition', 'Inspect retention, promotion, reconciliation and fallback evidence through the worker contract. Revision checks and backend policy determine which transitions are permitted.', 'office-harness --tool-status PLAN'],
  ['Preparation and dispatch', 'Saved scope → prepared workspace → accepted card execution', 'Preparation validates the accepted kit’s supported adapters. Workspace preparation before claim is a separate configured capability. The library does not start a worker or dispatch a card.', 'office-harness --prepare-accepted'],
];

export function capabilityCards() {
  return h('section.harness-capability-grid', { 'aria-label': 'Worker capability reference' }, ...CONTRACTS.map(([name, relation, description, command]) =>
    h('details.harness-capability', {}, h('summary', {}, h('span.harness-eyebrow', {}, 'WORKER CONTRACT · DEPLOYMENT UNVERIFIED'), h('strong', {}, name), h('span', {}, relation)),
      h('p', {}, description), h('p.harness-muted', {}, 'No browser action. Verify support in the authenticated worker; this reference does not detect deployment or runtime health.'), h('code', {}, command))));
}
