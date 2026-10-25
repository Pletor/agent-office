# Harness library

For live, version-specific coding documentation, see [Context7 documentation tools](harness-context7.md). Agents can use the built-in `office-harness --docs-resolve` / `--docs` commands without changing their runner's native MCP configuration.
For bounded executable/version/help observations, see [runner probes](harness-probes.md).
These do not configure a runner or prove a tool is ready in another worker environment.

Catalog aliases preserve inherited selections during resource identity migration. New kit proposals use the canonical catalog ID and reject selecting an alias together with that same canonical resource. Previously accepted kits and historical evidence remain unchanged; evidence for different IDs is not pooled automatically.

For automatic problem-specific kit preparation, toolbox descriptors and measured ranking, see [Harness recommendations](harness-recommend.md). `office-harness --recommend` proposes context without executing resources or changing accepted assignments.

Back to the [README](../README.md).

The [autonomous learning contract](harness-learning.md) combines the seven-level H01–H24 plan with measured tool selection, versioned experiences, Context7 and OpenViking. It distinguishes planned behavior from the implementation described below.

![Harness and Docs on either side of the balcony doors](images/harness-shelves.png)

The **Harness** bookshelf stands on the other side of the balcony doors from **Docs**, with the same wooden case and books. Walk up and press **E**. The window supports search, category and source filters, source availability, reading, and a selection of up to 24 resources. **Zkopírovat balíček** or **Stáhnout balíček** produces a model-neutral Markdown context pack with source paths. Close with the top-right ✕ or Esc to return to mouse-look.

The full-screen [library workspace](harness-library.md) is in Czech and has four pages: Přehled, Prostředky, Výbava and Pro agenty. Výbava has the seven-level switches with explicit save and inheritance; Přehled reports the floor's status (resources, supported hierarchy, Opora binding, edit rights) and the sources found. Pro agenty lists the worker's commands as references, not browser toggles.

The handbook covers instructions, skills, hooks, rules, commands, scripts, tools, MCP, memory, evaluations and operating procedures. Local resources appear alongside it. Resources are displayed as plain text; selecting one does not execute code, install a plugin, change a model's permissions or configure its runner. Use the native runner's configuration for hooks and MCP.

![Selecting memory references for a context pack](images/harness-library.png)

## Publish resources

Each floor reads its own project:

- Root instruction files: AGENTS.md, CLAUDE.md and GEMINI.md.
- .agents/skills, .claude/skills, .claude/commands, .claude/rules, .cursor/rules and .github/instructions.
- **.harness/**: publish additional instructions, hooks, commands, scripts, tools, MCP examples, sanitized memory exports, tests and runbooks here. Use matching subfolder names for categories.

Example layout:

```text
.harness/
  instructions/task-start.md
  hooks/after-tool.py
  rules/review.md
  commands/release.md
  scripts/check.ps1
  tools/browser.md
  mcp/example.json
  memory/decisions.md
  testing/evaluations.md
  operations/handoff.md
```

Publish only resources intended to be shared with people on that office. Files in these folders are available to signed-in users. The library skips credential-like filenames, environment files, binary files, symlinks, build/dependency folders and files over 128 KiB; these filters are not a secret scanner. Do not put credentials in published files. Discovery is bounded to 1,200 entries, 6,000 visited paths and 10 directory levels. The UI indicates a truncated catalog.

Links (symlinks and Windows junctions) are never followed inside a published folder, even when they point somewhere else in the project. Copy files into the folder instead of linking them. A published folder may sit behind a link only if its real location stays inside the project. Listing a resource does not permanently authorize reading it. Every read checks the disk again, and the resource is treated as unavailable if any of these has changed since the catalog was loaded:

- the project or published folder now resolves to a different real location;
- the published folder, a folder below it or the file has been replaced with a link;
- the file's real path is no longer exactly that file in the published folder.

The server also checks that the opened file is the same one it validated before and after reading, compared by file ID. Editing a file, including saving it by replacing the file, keeps it readable. These are path checks. They make a concurrent rename race much narrower but do not eliminate it: someone who can rename folders in the project at exactly the right moments could still succeed. Hard links to files elsewhere are not detected because they are the same file. Only publish folders in projects whose writers you trust.

Admins and shared-password sessions also see the machine user's .agents/skills, .codex/skills, .claude/skills and .claude/commands. Named non-admin accounts only see project resources and the handbook. To publish another machine resource folder, set **AGENT_OFFICE_HARNESS_DIR** before starting the office. Refresh re-reads resources from disk.

## OpenViking

Set **AGENT_OFFICE_OPENVIKING_DIR** to the downloaded OpenViking repository. The library indexes its agent-plugins, docs/en and examples folders, including the portable memory skill, MCP proxy and runner-specific integration instructions. If unset, discovery checks up to seven project ancestors for OpenViking or 03.Agents-tools/OpenViking; it does not search the whole disk.

In PowerShell, before starting the office:

```powershell
$env:AGENT_OFFICE_OPENVIKING_DIR = 'P:\path\to\OpenViking'
agent-office
```

The source status says whether those files exist, **not** whether a memory server is connected. Read the installed version's agent-plugins/README.md and the integration guide matching your runner. The portable package starts its MCP proxy with Node and expects an OpenViking server, normally at http://127.0.0.1:1933. Its credentials stay in the native environment/configuration, outside exported context packs.

Configure the plugin in the chosen runner, verify a harmless memory read, then use its recall/persist workflow. Downloading the repository or opening this shelf does not start a server or expose private memories. To include selected memory in a portable context pack, publish a sanitized export under .harness/memory/.

## Any model with a shell or file input

After building the office, a local agent can use the same catalog without a browser:

```sh
node /path/to/agent-office/bin/office-harness.js --project /path/to/project
node /path/to/agent-office/bin/office-harness.js --project /path/to/project --read guide:instructions
node /path/to/agent-office/bin/office-harness.js --project /path/to/project --bundle guide:instructions guide:memory
```

Outside an office worker, the first command emits JSON with stable resource IDs; use those IDs with --read or --bundle. Local CLI access uses the current OS user's files and permissions and does not execute resources. Inside a worker (when `AGENT_OFFICE_HOOK_URL` is set), the command uses the authenticated office API instead, with the commands below; it never falls back to unrestricted local discovery. Remote models can receive the downloaded Markdown file or pasted context pack. Hooks, tool calls and MCP require support from the agent runner, independently of which model it runs.

A pack is a snapshot assembled from selected files at export time. Re-export after editing sources. It is reference material: repository instructions and the task's permissions still apply.

## Run and try the cascade

Build with `npm run build`, then run `node bin/agent-office.js . --port 4617 --password harness-preview --no-open` from a separate test checkout. Open http://localhost:4617, sign in, enter the office, and press **F8**. Alternatively, use **E** at the Harness shelf left of the balcony doors. The library fills the whole browser window. **✕** (top right) and **Esc** both return immediately to mouse-look.

Keyboard: the library opens on Přehled; **/** opens Prostředky and focuses search, **↑/↓/Home/End** move through the resource list, and **Tab** stays inside the library until you close it, after which focus returns to where it was. On a phone (≤ 700 px) the resource list and the reader take turns on the screen; **← Prostředky** goes back to the list. Loading shows placeholder rows, a failed load or read offers **Zkusit znovu**, and an empty catalog or a search with no results says what to do next. Animations stop under the system's reduced-motion setting. The example password is for a loopback-only disposable preview, not a network deployment.

Open **Pracovní výbava** for the seven-level checkbox editor. Choose a project, connect its floor to the open Opora project/workspace, then select the page, layer, area, sector or card. Enabled resources show where they came from; uncheck to disable their slots here or choose **Dědit** to restore inheritance. Save explicitly. Advanced JSON supports scalar settings and named resource slots. Changing scope or project requires saving or explicitly discarding edits; failed saves retain the draft.

See [Seven-level Harness inheritance](harness-hierarchy.md) for the exact Canvas mapping, binding rules, migration/backup requirements, agent commands and verification. Global defaults are shared across floors of this office instance. Independent offices do not share a global store. Repository identity is the absolute checkout path; node keys include project, workspace and card IDs.

## Orchestrator handoff

Use `office-harness --hierarchy` to inspect the real hierarchy and its profile/binding revisions, `--bind PROJECT WORKSPACE REVISION` to connect the open project, and `--configure LEVEL assignments.json --task KEY` to save a node layer. The file contains `revision`, `pathDigest` and the complete replacement `layer`. Only the active administrator-owned planner/router may edit; global writes belong to the administrator UI. Ordinary workers can read project resources. Browser mutations require same-origin administrator sessions.

The legacy `--effective` / `--assign repository|task` commands remain compatible with custom/unbound task IDs. Bound Opora nodes require `--hierarchy` / `--configure` for writes. Read-only local catalog and bundle commands are unchanged.

Context v1 handoffs resolve all seven levels before claiming a bound Opora card and embed the resource contents and snapshot digest. Missing resources or unavailable bindings block preparation; later edits do not change a seated worker. Context v2 receives its immutable accepted Canvas assignment without dynamic Harness additions. Limits remain 64 slots per layer, 24 distinct effective resources, 96 KiB resolved handoff and 2 MiB profile storage.

Scalar settings are context requirements, not runtime provider flags. Selecting tools, scripts, hooks, MCP or memory references does not execute, install, connect or grant permission to them. This hierarchy change does not add automatic recommendation, outcome measurements, Context7 queries or OpenViking persistence.

## Accepted tool kits

`office-harness --kit ts.references guide:testing guide:rules` emits a `harness.kit/1`
JSON object with exact resource content and SHA-256. A local shell can use
`node bin/office-harness.js --project PATH --kit ts.references RESOURCE_ID ...`
after building. Office workers use the same command through their authenticated
hook connection; ordinary workers can select project-published resources and
portable guides, while machine resources retain the catalog's administrator boundary.
The browser session equivalent is `GET /api/harness/kit?floor=F&problem=P&resource=ID`
(repeat `resource` for each selection).

Add the object as `fields.harness` in an ordinary Opora specification proposal.
This requires an Opora server supporting `harness.kit/1` (Canvas PR #46). Existing
servers reject the optional field rather than activating a live mutable fallback.
Set `AGENT_OFFICE_OPORA_CONTEXT_VERSION=2` on the office server for card execution;
the default legacy context cannot execute a card with a pinned kit. Opora rejects
that downgrade explicitly. Build and restart both server and client when deploying.
The kit has at most 24 distinct resources and 96 KiB including JSON metadata and
Unicode escapes. An empty selection pins an empty kit. IDs are catalog IDs, never
filesystem paths. The chosen slot is stable for each resource ID.

`requires` starts empty because catalog documents do not prove runner capabilities.
The planner must declare and verify execution requirements when preparing executable
tools. Categories now include `plugins` and `permissions`; both are published
references. No tool or plugin is installed or run by this command. Missing and
inaccessible resources fail the complete build. Later edits produce new hashes while
previously emitted kits retain their exact content. On PowerShell, save stdout with
`| Set-Content -Encoding utf8 kit.json` when a UTF-8 file is needed by another CLI.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. Focused coverage: `node --import tsx --import=#tests/css --test tests/harness*.test.ts tests/opora.test.ts tests/size.test.ts`.

With the isolated office running on 4617, `node tests/harness-office.browser.mjs` tests the **production bundle**, real session/catalog, F8 and **E** at the shelf (both open with an empty search, so the E isn't typed into it, and searching *hooks* finds *Hooks and lifecycle*) and ✕/Esc mouse-look behavior. For the hierarchy visual lab, run Vite on 5192 and `node tests/harness-hierarchy.browser.mjs`; it exercises all seven selectors and checkbox saves against a disposable fixture. It launches no paid agents and writes no live settings. `node tests/harness-screens.browser.mjs` (Vite on 5187, after `npm run build`) checks the full-screen layout at 1440 × 900 and 390 × 844: ✕ placement, focus trap and return, keys, phone panes, long content, loading, error, empty and no-match states, and no sideways scroll. `node tests/harness.browser.mjs` (Vite on 5187, after `npm run build`) serves the lab page from the real catalog and reader, then walks the library: opening it, adding a memory resource to a context pack, downloading the pack, Esc and ✕, the no-match state and the 390 px phone layout without sideways scroll, with no page errors. `HARNESS_OFFICE_URL`, `HARNESS_PASSWORD`, `HARNESS_FLOOR`, `HARNESS_LAB_URL` and `HARNESS_SHOTS` customize these tests. Screenshots default to the OS temporary directory.

![Persisted inheritance editor and scope provenance](images/harness-cascade.png)
