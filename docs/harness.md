# Harness library

Back to the [README](../README.md).

![Harness and Docs on either side of the balcony doors](images/harness-shelves.png)

The **Harness** bookshelf stands on the other side of the balcony doors from **Docs**, with the same wooden case and books. Walk up and press **E**. The window supports search, category and source filters, source availability, reading, and a selection of up to 24 resources. **Copy pack** or **Download pack** produces a model-neutral Markdown context pack with source paths. Close with the top-right ✕ or Esc to return to mouse-look.

The handbook covers the thirteen categories: instructions, skills, hooks, rules, commands, scripts, tools, MCP, memory, plugins, permissions, testing and operations. Each category states its purpose (the tooltip of the category filter, and a line under the toolbar when one is selected), and every element sits in a group inside its category, the folder it was published in, so a category reads as a shelf rather than a heap of files. Local resources appear alongside the handbook. Resources are displayed as plain text; selecting one does not execute code, install a plugin, change a model's permissions or configure its runner. Use the native runner's configuration for hooks and MCP.

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
  plugins/office/plugin.json
  permissions/allow-list.md
  testing/evaluations.md
  operations/handoff.md
```

A file is categorised by the first category name on its path, in path order and in any form (`hooks/claude/after-tool.py` is a hook in group `claude`; `runbooks/hooks.md` is a runbook); singular folder names and `runbooks` work too, and a `SKILL.md` is always a skill. Files that match no category take the source's default (instructions for project folders, skills or commands for machine folders, memory for OpenViking).

Publish only resources intended to be shared with people on that office. Files in these folders are available to signed-in users. The library skips credential-like names anywhere on the published path (`secret(s)`, `credential(s)`, `auth` as a whole word, `token`, `password`, `apikey`/`api-key`, `id_rsa*`, `id_ed25519*`, `kubeconfig*`, `service-account*.json`, `.env*`, `.pem`/`.key`/`.p12`; `authors.md` or `oauth-flow.md` stay listed), binary files, symlinks, build/dependency folders and files over 128 KiB; these filters are not a secret scanner. Do not put credentials in published files. Discovery is bounded to 1,200 entries, 6,000 visited paths and 10 directory levels. The UI indicates a truncated catalog.

Links (symlinks and Windows junctions) are never followed inside a published folder, even when they point somewhere else in the project. Copy files into the folder instead of linking them. A published folder may sit behind a link only if its real location stays inside the project. Listing a resource does not permanently authorize reading it. Every read checks the disk again, and the resource is treated as unavailable if any of these has changed since the catalog was loaded:

- the project or published folder now resolves to a different real location;
- the published folder, a folder below it or the file has been replaced with a link;
- the file's real path is no longer exactly that file in the published folder.

The server also checks that the opened file is the same one it validated before and after reading, compared by file ID. Editing a file, including saving it by replacing the file, keeps it readable. These are path checks. They make a concurrent rename race much narrower but do not eliminate it: someone who can rename folders in the project at exactly the right moments could still succeed. Hard links to files elsewhere are not detected because they are the same file. Only publish folders in projects whose writers you trust.

Admins and shared-password sessions also see the machine user's .agents/skills, .codex/skills, .claude/skills and .claude/commands. Named non-admin accounts only see project resources and the handbook. To publish another machine resource folder, set **AGENT_OFFICE_HARNESS_DIR** before starting the office. Refresh re-reads resources from disk.

## Element IDs, revisions and digests

Every element has three identifying fields in the catalog, the CLI output and the context pack header (`Element: <id> · revision <n> · sha256:<digest>`):

- **id**: a local installation ID of the form `el:<namespace>:<20 hex>`, derived from the element's namespace and its path from the namespace root, never from where the folder is on disk. Namespaces are `project` (the floor's checkout: `AGENTS.md`, `.harness/...`, `.claude/skills/...`), `machine` (the OS user's skill and command folders), `published` (**AGENT_OFFICE_HARNESS_DIR**), `openviking` and `handbook`. A restart or a moved checkout keeps every ID, and two checkouts of the same repository (worktrees, a clone on another disk) share the IDs of the elements they both hold. On case-insensitive filesystems the path is case-folded first. Handbook entries keep their readable IDs (`guide:testing`).
- **version**: a revision kept in `<office dataDir>/harness-registry.json`, beside the profiles. It is a label on a digest, not a counter of the element: the number the element's current content got when that content was first listed. New content always gets a number higher than any the element has had, and content seen before keeps its number, so switching a worktree back to an older branch shows the older content's lower number again (3 → 1 is content coming back, not a rollback of the registry). The digest is the identity; compare digests, not versions, to tell whether two listings hold the same content. The registry stores digests and metadata only, never content. Each update is a read-modify-write under a lock file (`harness-registry.json.lock`, holding its owner's token; waiting is bounded to about a second and asynchronous; a lock older than 10 s is taken over, a younger one never deleted), so the office and the CLI can share it. A registry that is locked, unreadable, unwritable or full never breaks a listing: the listing is not recorded. When it could not be read or locked, every version in that listing reads 0; when it was read but the save was refused (unwritable, full), only the revisions assigned in that listing read 0 and numbers persisted earlier are still served. The same ID can live in several places at once, two worktrees of one repository or two projects with the same layout, and the record keeps the content, revision and tombstone state of each place separately while all places share the revision numbering, so content seen in one place keeps its number in the other. The registry remembers the real folder of each place (the checkout a project folder belongs to; a machine or OpenViking folder itself); when that folder is gone while a folder above it (other than the volume root) still exists, the place is a deleted checkout and its records are pruned at the next save, so worktrees that come and go do not accumulate. A checkout that merely switched to a branch without `.harness/` keeps its records. A place whose whole path down to the volume root is gone (an unmounted disk) and a place on a network path are kept. The file is capped at 8 MiB: when a save would pass it, fully tombstoned records are pruned first; if it still does not fit, the save is refused and the new revisions read 0.
- **digest**: SHA-256 of the file as listed; a read reports the digest of the bytes actually returned. Digests of unchanged files (same file ID, size and mtime) are reused from `<office dataDir>/harness-digests.json`, a cache of paths and digests (never content) shared by the office and the CLI, so a fresh process does not hash every file again; a file whose identity key has not changed is not re-read by a listing, and a read never relies on the cache.

A shared element, such as a machine-level skill, has one ID in every project. Assignments reference IDs, and each project's layers are stored separately, so one project changing its assignments, or the shared file changing its content, never changes another project's assignments: both see the same ID at the new revision.

A project element (`el:project:…`) also has one ID in every project that holds the same relative path, but it is a different file in each, so the **global layer may bind only handbook, machine, published and OpenViking elements**; project elements are bound at repository scope or below (task, and the node levels H02 adds). Saving a global binding to a project element is refused (400, "Project-scoped element in global layer"), and a profile store that already holds one (written before this rule, or by hand) blocks the handoff in every project as "unavailable: project-scoped element in global layer" rather than quietly binding the other project's same-path file.

When a listed element disappears, its registry record stays as a **tombstone**. An assignment that points at it resolves as *missing* (with the last known path, revision, digest and the time it went missing), is refused when saved and blocks a handoff, and is never silently remapped to another file. Only a complete listing of the element's own source instance can tombstone it there, so one project's listing never marks another project's elements as gone; a listing cut short by the discovery bounds, by a folder that could not be read, or by a file whose read was denied or busy (EACCES, EPERM, EBUSY) marks nothing in that source, and the unreadable file is simply not listed until it can be read again; only a file that is absent (ENOENT) from a complete listing is tombstoned. An element that is still published in another place resolves as not available here rather than as gone (`missingSince` is set only once it is gone from every place it was listed). If the file comes back at the same place it gets the same ID again, with the number its content has: the same number when the content is the one seen before, a new higher one for new content. `resolve()` describes only namespaces the library publishes, so a non-admin library answers *unknown* for a machine element rather than revealing its title or path. An unreadable registry fails closed: versions read 0, nothing resolves as missing, and the file is left for repair.

Profiles saved before this registry hold the previous IDs, hashes of the absolute path. Each element lists those as `aliases`; they resolve, read and bundle exactly like the canonical ID, and the catalog shows the canonical one. An alias is a hash of the absolute path, so it does not follow a moved checkout: after a move the old alias resolves as *unknown* and a profile that still uses it blocks the handoff; reassign such slots to the canonical ID (which did follow the move).

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
node /path/to/agent-office/bin/office-harness.js --project /path/to/project --catalog
node /path/to/agent-office/bin/office-harness.js --project /path/to/project --read guide:instructions
node /path/to/agent-office/bin/office-harness.js --project /path/to/project --bundle guide:instructions guide:memory
node /path/to/agent-office/bin/office-harness.js --project /path/to/project --resolve el:project:0123456789abcdef0123
```

Outside an office worker, the first command emits JSON with each element's id, version, digest, category, group and aliases; use the IDs with --read, --bundle or --resolve (available, missing or unknown). Revisions come from the registry in the office data dir: `--data-dir <folder>`, else **AGENT_OFFICE_DATA_DIR**, else `<project>/.agent-office` when that folder holds the office's `config.json` (a floor's own `.agent-office` does not count); without one, versions read 0 and no tombstones are kept. Point the CLI at the office's data dir to see the same revisions and tombstones as the office and its handoffs. Local CLI access uses the current OS user's files and permissions and does not execute resources. Inside a worker (when `AGENT_OFFICE_HOOK_URL` is set), the command uses the authenticated office API instead, with the commands below; it never falls back to unrestricted local discovery. Remote models can receive the downloaded Markdown file or pasted context pack. Hooks, tool calls and MCP require support from the agent runner, independently of which model it runs.

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

The levels are the ones of the [Opora identity contract](opora-identity.md). The project level is the repository checkout (stored as `repo:<hash of the checkout path>`, not an Opora node); every level below it is a real Opora node, named by its key `opora:PROJECT:WORKSPACE:NODE`, never by a name or a position on the canvas.

- **Global** applies to all floors in this office instance. Separate running offices do not share this store.
- **Project** is the repository Opora plans: this floor's checkout. The 3-level store, the CLI and the HTTP API still accept `repository` as its name. A root sector of the canvas (a domain of the switchboard) is the project's, not a level of its own.
- **Page**, **Layer**, **Area**, **Sector** are the nodes on the way down from the project to a card, read from the canvas's real parents: the deepest sector above the card is the sector, the area that sector is a `memberOf` (`areaOf`) is the area, the cards above the sector are the page (outermost) and the layer (innermost). Area membership, parents and kinds are the contract; which card is a "layer" is Opora's convention of nesting one card under the page (`[vrstva NN]`), so a card right under a page has no layer and a canvas without `memberOf` has no area, and those levels are simply empty (the editor says so: "No area level: this canvas has no area membership (memberOf)").
- **Area** layers are reachable through the area's own key: a layer saved at an area applies to every card whose sector is a member of that area (`memberOf`, under the same parent), in every such sector. That is what area membership means here; a canvas without `memberOf` has no area level anywhere (a card with no sector above it that is itself a `memberOf` an area gets that area, the same way).
- A card between the page and the layer has no level on any task's path. Addressed by itself it looks like a layer, so a save at `layer` through it is refused (HTTP 400, "no task's path goes through it") instead of being written where nothing inherits it; save at the page above it, or at the layer right above a sector. Every other node is reachable by what's under it, or is its own task.
- **Task** is the card itself: any card under a sector, children or not. That a card under a sector with sub-cards is still a task, and the sub-card a task of its own with the card above it setting nothing for it, is a **decision** of this office, not a reading of the canvas: a sub-card is work of the card above it, both share the sector and everything above it, and neither is a "layer" of the other. With no sector above, a card with nothing under it is a task and one with children is a page or a layer. An area addressed by its own key is the area of its path. Task IDs from Opora include project, workspace and card, so the same short ID elsewhere cannot collide; a custom task ID that isn't an Opora key has nothing above it but the project.
- A missing key inherits. `null` explicitly disables an inherited assignment. Delete the override to inherit again. A binding replaces the whole binding at that key; there is no deep merge or instruction concatenation for the same slot.
- Each level sets only its own slots (its **own view**, `layers.<level>`); the **effective** result (`effective`) says for each slot which level it came from (`scope`) and, below the project, which node (`node`, its key, and `nodeName`, its name on the canvas when the office knows it). The editor shows it as a table: slot, value, level, node. Siblings are isolated: a sibling sector, page or task sees only what is above both, never what the other set.
- One **revision** covers every level. A save sends the revision it loaded; if anyone saved anything at any level since, it is refused (HTTP 409) and the editor must reload. A save below the project at a node of the canvas must also name the node it was edited for (`at`, the key of the node at that level on the `path` the preceding read returned; HTTP 400 without it); if the canvas has since moved the target so that level is another node, it is refused (HTTP 409) rather than written where nobody looked. The editor and the CLI send it; a custom task ID that isn't on the canvas needs none. Every save goes into an **audit** trail (when, revision, level, node, repository, who, which slots the layer names now; `[]` when the layer was removed), shown under **Latest saves**. A reader gets the audit of its floor's repository; global saves, other repositories' and entries from before the repository was recorded are shown to administrators only, and a worker (the orchestrator included) never sees another floor's keys, slots or accounts.

Try `{"settings.color":{"value":"red"}}` globally, `blue` for the project, `teal` for a card's sector and `green` for the card. Save each layer and inspect **Effective slots and their origins**. Removing the task override should reveal `teal`, then `blue`, then `red`; a sibling card in the same sector shows `teal`. Load a task or node (type its key, or pick a card) before saving at a level below the project: the **Path** line shows the way down the loaded node, and the levels it doesn't go through can't be edited. Switching scope or reloading discards unsaved edits.

For resources, choose a semantic slot and scope in the inheritance editor, collapse it, select a book, click **Assign resource**, and **Save layer**. The first opening loads profiles automatically; the default slot is `rules.quality` at project scope. Assignment edits and ad-hoc **Add to pack** selections are intentionally separate. Saving a layer persists assignments; exporting a pack does not.

**Resolved handoff preview** shows the exact saved configuration/content to be supplied to a worker, with the path, each slot's provenance and SHA-256 snapshot digest. Missing or inaccessible resources show a blocking warning. Repository identity is the absolute checkout path (case-insensitive on Windows); moving a checkout requires reassigning its profiles, while the canonical element IDs inside them stay valid; a pre-registry alias (hash of the old absolute path) does not follow the move and resolves as unknown (see Element IDs). Resource IDs are local installation IDs, not portable package names.

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

- `global`, `repo:` and `task:` keys are exactly what version 1 wrote; a version 1 file (no `version`, no `audit`) loads as it is, and nothing is rewritten until someone saves. For the three levels version 1 had, the effective result is the same; the levels in between are empty until someone sets them, so a card that has a sector with a layer of its own in this office resolves differently from how the 3-level office resolved it, as intended.
- **The one-time lift of `task:` keys.** A `task:` layer version 1 gave a node that the canvas now places above the task level (a sector, a page, a layer assigned with `--assign task`) is read as that level's own layer and inherits down to its cards. This applies to the keys version 1 wrote and to no others: the first save that makes the file version 2 lists them in `legacyTasks`, and a `task:` key this office writes (a task save of a lifted card included, which takes the key off the list) is the card's task layer for good; when that card later gains children and becomes a page or a layer, its task layer is not handed down to them (its children inherit from the levels above, not from the former leaf). A save at the lifted level writes the node's `node:` key, takes the key off `legacyTasks` and leaves the `task:` key in the file as it was; removing the `node:` layer later does not bring the old key back.
- Page, layer, area and sector layers are new `node:` keys; the first save writes `version: 2` and starts the `audit` (the latest 200 saves, each with the repository it was for). A file with a version this office doesn't know fails closed, like invalid JSON: it is reported, never overwritten.
- **Rollback** to a 3-level office is a deploy of the older version and nothing else: it reads `revision` and `layers`, knows the `global`, `repo:` and `task:` keys and ignores `version`, `audit`, `legacyTasks` and the `node:` keys, which stay in the file, dormant, through its saves, and resolve again on the next upgrade. A lifted `task:` layer is still there for it, as version 1 wrote it: after this office saved that level, the old office sees the layer as it was before that save, not the edit, which lives at the `node:` key it doesn't read. A `task:` key the old office writes *during* a rollback (the file is version 2 by then) is not in `legacyTasks`, so after the next upgrade it is that card's task layer and is not lifted. To drop the hierarchy for good, stop the office and delete the `node:` keys, `version`, `audit` and `legacyTasks` from the file. `tests/harness-cascade.test.ts` ("a 3-level store loads unchanged…" and "a task layer the 3-level store gave a node that is a sector today…") runs these round trips with the real version 1 store code, vendored in `tests/fixtures/harness-profiles-v1.ts`.
- **Two offices on one data directory.** A save is read-check-write under an exclusive lock file (`harness-profiles.json.lock`, created with `O_EXCL`, waited for up to 3 s, taken over when older than 10 s), so a second office process on the same `dataDir` can't overwrite a save it never read; `tests/harness-cascade.test.ts` runs two processes doing 50 saves each and finds every accepted save in the file. A save that can't get the lock in time is refused (HTTP 503) and can be retried.

## Project bindings and orchestrator contract

A floor's profiles are keyed by its checkout (`repo:<sha256 of the path>`); which Opora **project and workspace** plan that checkout is written down once, as the floor's **binding**, instead of being guessed from the 🛰️ Opora window at every save. The binding is `{project, workspace, repoHash, floorId, checkoutPath, boundAt, boundBy}` in `<dataDir>/harness-bindings.json` (the profiles file is unchanged); project identity is Opora's ids, never a name. A floor is bound to one project + workspace at a time. Binding names what the floor's window reads at that moment (another project or workspace is refused, 409: link the window first), so the two never start apart; from then on the binding is the authority and a window that drifts away from it stops writes at Opora nodes until someone relinks or rebinds. **Rebinding** is explicit (`rebind: true`, CLI `--rebind`), audited (`from` → `to`, by whom) and leaves the old binding's profiles in the store under the checkout's key: the old workspace's node keys are another workspace's now and resolve to nothing, a rebind back finds them again. The profile replies carry `binding: {project, workspace, repoHash, floorId}` (or `null`).

| HTTP | CLI (inside a worker) | Who | What |
| --- | --- | --- | --- |
| `GET /api/harness/binding?floor=ID` · `GET /office/harness/binding?worker=ID` | `office-harness --binding` | any session of the office · any worker of the floor | `{binding, revision, audit, writable}` |
| `POST /api/harness/binding?floor=ID` · `POST /office/harness/binding?worker=ID` `{project, workspace, rebind?, revision?, requestId?}` | `office-harness --bind PROJECT WORKSPACE [--rebind] [--request-id ID]` | administrator or shared-password session (same origin) · the live Opora planner/router an administrator owns | binds; the same place again is a no-op (`changed: false`, nothing written); another place needs `rebind`; `revision` is compare-and-set (409); 503 while Opora isn't answering, 409 while no project is linked or the window reads another one |
| `GET /api/harness/profile?floor=ID[&node=KEY]` · `GET /office/harness?worker=ID[&node=KEY]` | `office-harness --effective [--node KEY]` | as before | the view, with `binding`; while Opora isn't answering it is the local store down the canvas as last read, and `warning` says so |
| `POST …/profile` / `POST /office/harness` `{scope, layer, revision, at?, project?, workspace?, requestId?}` | `office-harness --assign LEVEL file.json [--node KEY] [--request-id ID]` | as before | a save at an Opora node is checked against the binding first (below); `project`/`workspace`, when sent, must be the floor's (409) |

What a save at an Opora node (a level below the project, a key `opora:P:W:NODE`) is refused for, in this order, each with nothing written: the floor is **not bound** (409, with the way out); the node is in **another project or workspace** than the binding (403: never remapped); **Opora isn't answering** (503: the node's place on the canvas can't be checked); the **window reads another project** than the binding (409: relink or rebind); the node **isn't on the canvas** as last read (400, with the node id). A custom task id, the project layer and the global layer need no binding and no canvas, so they work while Opora is down. Card dispatch obeys the binding too: a floor bound to one project hands out no card of another (the dispatch fails before the lease is claimed); an unbound floor dispatches as before.

**Safe retries.** A write may carry a `requestId` (1–100 characters of letters, digits, `_`, `.`, `:`, `-`; CLI `--request-id`). The office keeps the last 20 accepted writes per repository (profiles) and per floor (bindings), each caller's own (`account:<id>`, `shared-password`, `worker:<id>`: a retry comes from the identity that wrote, and nobody is handed another's reply), in `<dataDir>/harness-requests.json`, with the request's payload digest and its result. The same `requestId` with the same payload gets the stored result back, with the header `x-harness-replay: 1`, and writes nothing: no second save, no second audit entry, the revision stays. The same `requestId` with another payload is refused (409) and never written. Without a `requestId`, the same payload at the same revision is a retry too and gets the stored result; another payload at a stale revision is the conflict it is (409). Only accepted writes are remembered, so a refused write retried after the cause is gone goes through.

**Authorization matrix** (`tests/harness-bindings.test.ts` runs it as a table):

| Caller | read profile | write below global | write global | read binding | bind |
| --- | --- | --- | --- | --- | --- |
| administrator session (same origin) | 200 | 200 | 200 | 200 | 200 |
| shared-password session | 200 | 200 | 200 | 200 | 200 |
| member session | 200 (own floor's context) | 403 | 403 | 200 | 403 |
| no session | 401 | 401 | 401 | 401 | 401 |
| administrator from another origin | 200 | 403 | 403 | 200 | 403 |
| Opora planner/router an administrator owns (worker token) | 200 | 200 | 403 | 200 | 200 |
| ordinary worker of the floor | 200 | 403 | 403 | 200 | 403 |
| planner a member owns | 200 | 403 | 403 | 200 | 403 |
| another floor's worker | 200, its own floor only | 403 | 403 | 200, its own floor only | 403 |
| forged token or worker id | 401 | 401 | 401 | 401 | 401 |

A worker's floor is derived from its hook token, never from the request, so another floor's worker can't address this floor at all; the audit names each writer (`account:<id>`, `shared-password`, `worker:<id>`).

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
office-harness --binding
office-harness --bind PROJECT WORKSPACE
office-harness --assign sector assignments.json --node 'opora:PROJECT:WORKSPACE:SECTOR' --request-id my-save-1
```

`--assign` takes a level: `repository` (or `project`), `page`, `layer`, `area`, `sector` or `task`; `--task` and `--node` are the same thing (pass one of them), the key of the node addressed, and the level must be on that node's way down (a sector assigned through one of its cards, or through the sector itself). Use the actual namespaced IDs returned by `--effective` (components are URL-encoded); a key of another project or workspace is refused. `assignments.json` contains `{"revision":N,"layer":{...}}`, with the latest revision and the **complete replacement layer**. Include unchanged slots you want to retain. For a level below the project the CLI reads `--effective` for the node right before saving and sends the key of the node at that level on its `path` as `at` (or the key given with `--at NODE_KEY`); a node whose path has no such level is refused before anything is sent, and a card the canvas moved in between is refused by the office (409): read `--effective` again and save again. Before assigning at Opora nodes the floor must be bound to the project and workspace it reads (`--binding`, `--bind`; see Project bindings and orchestrator contract), and `--request-id` makes a save or a bind safe to retry. Outside a worker (no `AGENT_OFFICE_HOOK_URL`) these commands say so in one line instead of running. Configure task requirements before making a card runnable; automatic handout may dispatch ready cards as soon as the orchestrator finishes a turn.

Browser writes require an administrator/shared-password session and same-origin requests. The worker endpoint uses the worker's hook token and derives its repository from that worker, not caller input. Only the active Opora planner/router belonging to an administrator (or shared-password session) may change the layers below global. Global writes are administrator UI-only. Ordinary workers can inspect their project-scoped effective context but cannot edit profiles or discover administrator machine resources.

Every `OporaBridge.take` path (manual take, autopilot, orchestrator handout) resolves profiles before claiming the card, down the card's way through the canvas as last read. It reads the selected resources, embeds the manifest (`task`, the key of the node dispatched, and `level`, its level: a card is a `task`, a sector handed out whole a `sector`; then `path`, `revision` and `slots` with provenance) and contents in the worker's initial prompt, and fails before claiming if something is unavailable or exceeds the budget. Later profile edits at any level, global included, do not change an already seated worker's prompt. Limits: 64 slots per layer, 24 distinct effective resources, 96 KiB resolved handoff, 2 MiB persisted profiles. Invalid saved JSON fails closed and is not overwritten.

This first integration applies to **Opora card dispatch**, not arbitrary direct hires or the unrelated file-planning queue. Scalar settings are **context requirements**, not runtime provider flags: `settings.model` does not change the actual model selection. Resources do not install hooks, execute scripts, connect MCP, start OpenViking, grant tool permissions or override native runner/user instructions. Confirm those capabilities in the selected runner before relying on them.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. Focused coverage: `node --import tsx --import=#tests/css --test tests/harness*.test.ts tests/opora*.test.ts tests/size.test.ts` (the cascade's table-driven tests of all seven levels, sibling isolation, null/reset, concurrent edits within one process and across two office processes, restart, the version 1 round trips and the lift of version 1 `task:` keys are in `tests/harness-cascade.test.ts`; the paths, the dead-end card and the sub-card decision in `tests/harness-hierarchy.test.ts`; the HTTP boundaries, `at`, the audit per floor, area reachability and the CLI's 409 on a moved card in `tests/harness-api.test.ts`; a dispatch down a page and a sector whose slots reach the worker's prompt, frozen there, in `tests/opora.test.ts`; the binding store, the authorization matrix, safe retries, CAS, an unknown node, Opora down, link drift, rebinding, a restart, the dispatch gate and the CLI's `--binding`/`--bind`/`--request-id` in `tests/harness-bindings.test.ts`). `tests/harness-registry.test.ts` covers the element registry: IDs across a restart and a checkout move, revisions following content, tombstones, shared elements between projects, credential exclusion and the compatibility aliases. `tests/harness-registry-robustness.test.ts` covers the adverse paths: a project element refused in the global layer and an old global binding blocking the handoff, a read-only registry and the 8 MiB cap (revisions read 0, file untouched), a denied read that tombstones nothing, pruning of deleted checkouts, two processes writing at once, a fresh process reusing the digest cache, aliases after a move, the credential filter on both lists and what `resolve()` tells a non-admin library.

With the isolated office running on 4617, `node tests/harness-office.browser.mjs` tests the **production bundle**, real session/catalog and F8/✕/Esc mouse-look behavior. For the editable visual lab, run Vite on 5187 and `node tests/harness-live.browser.mjs`: this forwards requests to the real authenticated office API, exercises the global, project and task layers and restores test settings unless a concurrent edit intervenes. It does not launch paid agents. `HARNESS_OFFICE_URL`, `HARNESS_PASSWORD`, `HARNESS_FLOOR`, `HARNESS_LAB_URL` and `HARNESS_SHOTS` customize these tests. Screenshots default to the OS temporary directory.

![Persisted inheritance editor and scope provenance](images/harness-cascade.png)
