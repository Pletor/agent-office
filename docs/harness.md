# Harness library

Back to the [README](../README.md).

![Harness and Docs on either side of the balcony doors](images/harness-shelves.png)

The **Harness** bookshelf stands on the other side of the balcony doors from **Docs**, with the same wooden case and books. Walk up and press **E**. The window supports search, category and source filters, source availability, reading, and a selection of up to 24 resources. **Copy pack** or **Download pack** produces a model-neutral Markdown context pack with source paths. Close with the top-right ✕ or Esc to return to mouse-look.

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

Build with `npm run build`, then run `node bin/agent-office.js . --port 4617 --password harness-preview --no-open` from a separate test checkout. Open http://localhost:4617, sign in, enter the office, and press **F8**. Alternatively, use **E** at the Harness shelf left of the balcony doors. **✕** and **Esc** both return immediately to mouse-look. The example password is for a loopback-only disposable preview, not a network deployment.

Open **Inheritance: Global → Project → Page → Layer → Area → Sector → Task**. Each level has a layer, a JSON object of named slots:

```json
{
  "rules.quality": { "resource": "guide:testing" },
  "settings.language": { "value": "cs" },
  "tools.browser": null
}
```

The levels are the ones of the [Opora identity contract](opora-identity.md): every level below global is a real Opora node, named by its key `opora:PROJECT:WORKSPACE:NODE`, never by a name or a position on the canvas.

- **Global** applies to all floors in this office instance. Separate running offices do not share this store.
- **Project** is the repository Opora plans: this floor's checkout. The 3-level store, the CLI and the HTTP API still accept `repository` as its name. A root sector of the canvas (a domain of the switchboard) is the project's, not a level of its own.
- **Page**, **Layer**, **Area**, **Sector** are the nodes on the way down from the project to a card, read from the canvas's real parents: the deepest sector above the card is the sector, the area that sector is a `memberOf` (`areaOf`) is the area, the cards above the sector are the page (outermost) and the layer (innermost). Area membership, parents and kinds are the contract; which card is a "layer" is Opora's convention of nesting one card under the page (`[vrstva NN]`), so a card right under a page has no layer and a canvas without `memberOf` has no area, and those levels are simply empty. A card between the page and the layer has no level and sets nothing.
- **Task** is the card itself: any card under a sector (a card between the sector and it has no level), or, with no sector above, a card with nothing under it (one with children is a page or a layer). An area addressed by its own key is the area of its path. Task IDs from Opora include project, workspace and card, so the same short ID elsewhere cannot collide; a custom task ID that isn't an Opora key has nothing above it but the project.
- A missing key inherits. `null` explicitly disables an inherited assignment. Delete the override to inherit again. A binding replaces the whole binding at that key; there is no deep merge or instruction concatenation for the same slot.
- Each level sets only its own slots (its **own view**, `layers.<level>`); the **effective** result (`effective`) says for each slot which level it came from (`scope`) and, below the project, which node (`node`). Siblings are isolated: a sibling sector, page or task sees only what is above both, never what the other set.
- One **revision** covers every level. A save sends the revision it loaded; if anyone saved anything at any level since, it is refused (HTTP 409) and the editor must reload. A save below the project also names the node it was edited for (`at`); if the canvas has since moved the target so that level is another node, it is refused the same way rather than written where nobody looked. Every save goes into an **audit** trail (when, revision, level, node, who, which slots the layer names now; `[]` when the layer was removed), shown under **Latest saves**.

Try `{"settings.color":{"value":"red"}}` globally, `blue` for the project, `teal` for a card's sector and `green` for the card. Save each layer and inspect **Effective slots and their origins**. Removing the task override should reveal `teal`, then `blue`, then `red`; a sibling card in the same sector shows `teal`. Load a task or node (type its key, or pick a card) before saving at a level below the project: the **Path** line shows the way down the loaded node, and the levels it doesn't go through can't be edited. Switching scope or reloading discards unsaved edits.

For resources, choose a semantic slot and scope in the inheritance editor, collapse it, select a book, click **Assign resource**, and **Save layer**. The first opening loads profiles automatically; the default slot is `rules.quality` at project scope. Assignment edits and ad-hoc **Add to pack** selections are intentionally separate. Saving a layer persists assignments; exporting a pack does not.

**Resolved handoff preview** shows the exact saved configuration/content to be supplied to a worker, with the path, each slot's provenance and SHA-256 snapshot digest. Missing or inaccessible resources show a blocking warning. Repository identity is the absolute checkout path (case-insensitive on Windows); moving a checkout requires reassigning its profiles. Resource IDs are local installation IDs, not portable package names.

## Store format and rollback

Profiles survive restarts in `<office dataDir>/harness-profiles.json`. The hierarchy store is **version 2** of the file the 3-level store (version 1) wrote, and it is a superset of it:

```json
{
  "version": 2,
  "revision": 7,
  "layers": {
    "global": { "settings.color": { "value": "red" } },
    "repo:<sha256 of the checkout path>": { "settings.color": { "value": "blue" } },
    "node:<repo>:opora:PROJECT:WORKSPACE:SECTOR": { "settings.color": { "value": "teal" } },
    "task:<repo>:opora:PROJECT:WORKSPACE:CARD": { "settings.color": { "value": "green" } }
  },
  "audit": [{ "at": "2026-10-20T10:00:00.000Z", "revision": 7, "level": "task", "node": "opora:…", "by": "account:ana", "slots": ["settings.color"] }]
}
```

- `global`, `repo:` and `task:` keys are exactly what version 1 wrote; a version 1 file (no `version`, no `audit`) loads as it is, with the same effective result, and nothing is rewritten until someone saves. A `task:` layer version 1 gave a node that the canvas now places above the task level (a sector, a page, a layer assigned with `--assign task`) is read as that level's own layer, inherits down to its cards, and is moved to the node's `node:` key on that level's next save.
- Page, layer, area and sector layers are new `node:` keys; the first save writes `version: 2` and starts the `audit` (the latest 200 saves). A file with a version this office doesn't know fails closed, like invalid JSON: it is reported, never overwritten.
- **Rollback** to a 3-level office is a deploy of the older version and nothing else: it reads `revision` and `layers`, knows the `global`, `repo:` and `task:` keys and ignores `version`, `audit` and the `node:` keys, which stay in the file, dormant, through its saves, and resolve again on the next upgrade. To drop the hierarchy for good, stop the office and delete the `node:` keys, `version` and `audit` from the file. `tests/harness-cascade.test.ts` ("a 3-level store loads unchanged…") runs this round trip with the real version 1 store code, vendored in `tests/fixtures/harness-profiles-v1.ts`.

## Orchestrator handoff

The Opora planner/router receives these instructions automatically and has `office-harness` on PATH:

```sh
office-harness --catalog
office-harness --effective
office-harness --effective --task 'opora:PROJECT:WORKSPACE:CARD'
office-harness --effective --node 'opora:PROJECT:WORKSPACE:SECTOR'
office-harness --assign repository assignments.json
office-harness --assign sector assignments.json --node 'opora:PROJECT:WORKSPACE:SECTOR'
office-harness --assign task assignments.json --task 'opora:PROJECT:WORKSPACE:CARD'
```

`--assign` takes a level: `repository` (or `project`), `page`, `layer`, `area`, `sector` or `task`; `--task` and `--node` are the same thing (pass one of them), the key of the node addressed, and the level must be on that node's way down (a sector assigned through one of its cards, or through the sector itself). Use the actual namespaced IDs returned by `--effective` (components are URL-encoded); a key of another project or workspace is refused. `assignments.json` contains `{"revision":N,"layer":{...}}`, with the latest revision and the **complete replacement layer**. Include unchanged slots you want to retain. Configure task requirements before making a card runnable; automatic handout may dispatch ready cards as soon as the orchestrator finishes a turn.

Browser writes require an administrator/shared-password session and same-origin requests. The worker endpoint uses the worker's hook token and derives its repository from that worker, not caller input. Only the active Opora planner/router belonging to an administrator (or shared-password session) may change the layers below global. Global writes are administrator UI-only. Ordinary workers can inspect their project-scoped effective context but cannot edit profiles or discover administrator machine resources.

Every `OporaBridge.take` path (manual take, autopilot, orchestrator handout) resolves profiles before claiming the card, down the card's way through the canvas as last read. It reads the selected resources, embeds the manifest (task, path, revision, slots with provenance) and contents in the worker's initial prompt, and fails before claiming if something is unavailable or exceeds the budget. Later profile edits at any level, global included, do not change an already seated worker's prompt. Limits: 64 slots per layer, 24 distinct effective resources, 96 KiB resolved handoff, 2 MiB persisted profiles. Invalid saved JSON fails closed and is not overwritten.

This first integration applies to **Opora card dispatch**, not arbitrary direct hires or the unrelated file-planning queue. Scalar settings are **context requirements**, not runtime provider flags: `settings.model` does not change the actual model selection. Resources do not install hooks, execute scripts, connect MCP, start OpenViking, grant tool permissions or override native runner/user instructions. Confirm those capabilities in the selected runner before relying on them.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. Focused coverage: `node --import tsx --import=#tests/css --test tests/harness*.test.ts tests/opora*.test.ts tests/size.test.ts` (the cascade's table-driven tests of all seven levels, sibling isolation, null/reset, concurrent edits, restart and the version 1 round trip are in `tests/harness-cascade.test.ts` and `tests/harness-hierarchy.test.ts`).

With the isolated office running on 4617, `node tests/harness-office.browser.mjs` tests the **production bundle**, real session/catalog and F8/✕/Esc mouse-look behavior. For the editable visual lab, run Vite on 5187 and `node tests/harness-live.browser.mjs`: this forwards requests to the real authenticated office API, exercises the global, project and task layers and restores test settings unless a concurrent edit intervenes. It does not launch paid agents. `HARNESS_OFFICE_URL`, `HARNESS_PASSWORD`, `HARNESS_FLOOR`, `HARNESS_LAB_URL` and `HARNESS_SHOTS` customize these tests. Screenshots default to the OS temporary directory.

![Persisted inheritance editor and scope provenance](images/harness-cascade.png)
