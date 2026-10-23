# Automatic work-kit preparation

An agent can assemble a problem-specific kit with one read-only command:

```sh
office-harness --recommend ts.references --task 'opora:PROJECT:WORKSPACE:CARD' --capability command:node
```

The authenticated worker command derives its floor, project and workspace from Office. Ordinary workers see project and explicitly shared resources; the active administrator-owned planner also sees permitted machine sources. The browser endpoint is `GET /api/harness/recommend?floor=F&problem=ts.references`; workers use `/office/harness?recommend=1`. Both return `harness.recommendation/1`: candidates, reasons, missing requirements, history availability, profile revision and a complete `kit` proposal. They never save profiles, claim cards, execute tools or promote resources.

Outside a worker, `node bin/office-harness.js --project PROJECT --recommend ts.references` uses the local published catalog. Native Office scope/history and persistent inheritance are unavailable and labeled accordingly. A configured worker hook never falls back to local machine discovery.

## Publish problem-matched tools

Create and test a resource in an isolated branch, then declare it in `.harness/toolbox.json`:

```json
{
  "schema": "harness.toolbox/1",
  "resources": [{
    "path": "scripts/check-types.mjs",
    "problems": ["ts.references"],
    "requires": ["command:node"],
    "priority": 20
  }]
}
```

The resource must exist in the same published source. Paths are relative and cannot escape it or refer to private machine files. Existing catalog boundaries, link checks, credential exclusions and size limits still apply. A manifest allows at most 64 distinct paths, each with 1–8 problem IDs, at most 16 distinct requirements and integer priority −100…100. Unknown fields such as `verified` are refused. Problem matching is exact; category comes from the actual catalog. Metadata changes during preparation refuse the result.

For shared access, the operator may set `AGENT_OFFICE_SHARED_HARNESS_DIR` to an intentionally published collection with the same `toolbox.json` format. Every floor and worker can read it. Personal skill folders and `AGENT_OFFICE_HARNESS_DIR` remain machine-owned and restricted. No private file is automatically published and no project outcome authority transfers between projects. Publication/review/write permissions stay with the existing repository/operator policy; automatic global promotion is disabled.

Agents may improve scripts, skills and rules through their normal code workflow. Keep implementations deterministic where possible, requirements explicit and tests tied to observable outcomes. The selector does not invent an implementation when none exists: it reports missing/unmeasured resources so the agent can prepare, test and register a suitable tool.

## Inheritance and selection

Inherited explicit assignments remain mandatory. Disabled inherited slots suppress automatic reintroduction, including checkbox overrides from the seven-level editor. `settings.harness.auto = {"value": false}` disables automatic additions; explicit resources and scalar context remain. An installed seven-level module supplies its bound Canvas path; older installations retain the existing three-level resolver. An installed but broken hierarchy module never silently falls back. Changed profiles or scope require a retry.

With automatic additions enabled, basic instruction/testing references are included unless disabled. The selector can add up to three sufficiently sampled candidates and **at most one** insufficiently measured candidate. It keeps the 24-resource / 96-KiB escaped-JSON budget. Scalar settings become a content-addressed `profile:settings` reference; they do not grant permissions or select runtime provider flags. Explicit unavailable resources or unresolved executable requirements return constraints and `kit: null` instead of silent substitutions.

Probe requirements in the actual runner before repeating `--capability ID`. These flags are caller declarations, not native attestation. A script/command/tool/hook/MCP/plugin explicitly selected without matching toolbox metadata needs its requirements declared before automatic preparation. Selecting text never proves a tool is installed, authenticated or permitted.

`proposalStatus` distinguishes `blocked`, `reference-only` and `tools-proposed`. `unresolvedCandidateRequirements` lists probes still needed for matching candidates. A reference-only proposal can contain the basic guides while every executable candidate is unavailable; it must not be presented as a complete runtime toolset.

## Measured experience

Office reads the configured floor's native Canvas `/api/oporahub/harness-learning` endpoint with its own project/workspace, a five-second deadline and a 256-KiB response limit. Wrong scope, malformed counts, duplicate cohorts and unavailable peers become explicit unknown history. Percentages and Wilson intervals are recomputed from counts. Limited history is reported; offline data cannot assert native verification.

Only exact resource ID, content digest, configuration digest and problem match. Text, category or requirement changes start a separate cohort. Agent reports remain separate and cannot qualify observed success. The initial ranking threshold is five known outcomes, three different cards, 80% coverage and a 95% Wilson lower bound of 50%. At least four failures with an upper bound below 50% suppress automatic addition; explicit policy choices remain unchanged and visible. Priority breaks ties, never creates verification.

These are **selected-kit associations**, not proof of invocation or causal contribution. Current cohorts are project/workspace-wide; runner, production incidents and finer hierarchy cohorts are not inferred. A 100% point estimate from one run remains insufficiently measured. No threshold guarantees correctness or authorizes global promotion. Recalled OpenViking facts are historical references; inspect their native source and current outcome before reuse.

For context v2, propose the returned `kit` as `fields.harness` through normal Opora acceptance. Preparation does not modify an accepted assignment or inject live material into a seated worker. Existing `--kit` remains available for explicit preparation. Unaccepted proposals carry no execution authority.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build`. Focused tests cover independent Python/TypeScript configuration identity, unknown evidence, scope/denominator validation, capability constraints, exact versions, inherited disable/auto-off, bounded exploration, metadata races and authenticated HTTP preparation. The feature makes no LLM call or OpenViking write.
