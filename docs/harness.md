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

Publish only resources intended to be shared with people on that office. Files in these folders are available to signed-in users. The library skips credential-like names anywhere on the published path (`secret(s)`, `credential(s)`, `auth` as a whole word, `token`, `password`, `apikey`/`api-key`, `id_rsa*`, `id_ed25519*`, `kubeconfig*`, `service-account*.json`, `.env` and `.env.*` (not other names that merely start with `.env`, such as `.envrc.md`), `.pem`/`.key`/`.p12`; `authors.md` or `oauth-flow.md` stay listed), binary files, symlinks, build/dependency folders and files over 128 KiB; these filters are not a secret scanner. Do not put credentials in published files. Discovery is bounded to 1,200 entries, 6,000 visited paths and 10 directory levels. The UI indicates a truncated catalog.

Links (symlinks and Windows junctions) are never followed inside a published folder, even when they point somewhere else in the project. Copy files into the folder instead of linking them. A published folder may sit behind a link only if its real location stays inside the project. Listing a resource does not permanently authorize reading it. Every read checks the disk again, and the resource is treated as unavailable if any of these has changed since the catalog was loaded:

- the project or published folder now resolves to a different real location;
- the published folder, a folder below it or the file has been replaced with a link;
- the file's real path is no longer exactly that file in the published folder.

The server also checks that the opened file is the same one it validated before and after reading, compared by file ID. Editing a file, including saving it by replacing the file, keeps it readable. These are path checks. They make a concurrent rename race much narrower but do not eliminate it: someone who can rename folders in the project at exactly the right moments could still succeed. Hard links to files elsewhere are not detected because they are the same file. Only publish folders in projects whose writers you trust.

Admins and shared-password sessions also see the machine user's .agents/skills, .codex/skills, .claude/skills and .claude/commands. Named non-admin accounts only see project resources and the handbook. To publish another machine resource folder, set **AGENT_OFFICE_HARNESS_DIR** before starting the office. Refresh walks the published folders again and re-reads the files whose identity changed; an unchanged file's bytes are not read again (see the digest cache below).

## Element IDs, revisions and digests

Every element has three identifying fields in the catalog, the CLI output and the context pack header (`Element: <id> · revision <n> · sha256:<digest>`):

- **id**: a local installation ID of the form `el:<namespace>:<20 hex>`, derived from the element's namespace and its path from the namespace root, never from where the folder is on disk. Namespaces are `project` (the floor's checkout: `AGENTS.md`, `.harness/...`, `.claude/skills/...`), `machine` (the OS user's skill and command folders), `published` (**AGENT_OFFICE_HARNESS_DIR**), `openviking` and `handbook`. A restart or a moved checkout keeps every ID, and two checkouts of the same repository (worktrees, a clone on another disk) share the IDs of the elements they both hold. On case-insensitive filesystems the path is case-folded first. Handbook entries keep their readable IDs (`guide:testing`).
- **version**: a revision kept in `<office dataDir>/harness-registry.json`, beside the profiles. It is a label on a digest, not a counter of the element: the number the element's current content got when that content was first listed. New content always gets a number higher than any the element has had, and content seen before keeps its number while it is in the element's history of the last 64 distinct digests, so switching a worktree back to an older branch shows the older content's lower number again (3 → 1 is content coming back, not a rollback of the registry). Content that has fallen out of that history, or whose record was pruned, comes back as new content with a new higher number (after 65 distinct contents the first one returns as revision 66). The digest is the identity; compare digests, not versions, to tell whether two listings hold the same content. The registry stores digests and metadata only, never content. Each update is a read-modify-write under a lock file (`harness-registry.json.lock`, created exclusively and holding its owner's token and a lease time; waiting is bounded to about a second and asynchronous). The owner renews the lease while it holds the lock; a lock whose lease is older than 10 s is taken over by renaming away the very file that was observed and checking its identity and content after the rename (a lock that changed meanwhile is put back), and release renames the lock away, verifies the token and only then deletes it, so a replacement lock is not deleted by a late release. Before committing, the writer checks that the lock is still its own and records nothing if it was taken over. This is a best-effort lease on a local filesystem, not a distributed consensus protocol: a writer stalled for longer than the lease loses its lock and its listing is not recorded, and network filesystems without atomic rename and hard-link semantics are not supported. The office and the CLI can share the registry. A registry that is locked, unreadable, unwritable or full never breaks a listing: the listing is not recorded. When it could not be read or locked, every version in that listing reads 0; when it was read but the save was refused (unwritable, full), only the revisions assigned in that listing read 0 and numbers persisted earlier are still served. The same ID can live in several places at once, two worktrees of one repository or two projects with the same layout, and the record keeps the content, revision and tombstone state of each place separately while all places share the revision numbering, so content seen in one place keeps its number in the other. The registry remembers the real folder of each place (the checkout a project folder belongs to; a machine or OpenViking folder itself); when that folder is gone (a status check fails with ENOENT or ENOTDIR, not with any other error) while a folder above it (other than the volume root) still exists, the place is a deleted checkout. It is pruned only when two consecutive saves both find it gone: the first records the sighting (`rootsMissing`), the second deletes its records, and a folder that is back, or cannot be checked, clears the sighting. Worktrees that come and go therefore do not accumulate, while a transient failure never deletes anything. A checkout that merely switched to a branch without `.harness/` keeps its records. A place is kept whenever the check fails with a permission or I/O error, when the volume root is not reachable (on Windows an unmounted disk or an offline mapped network drive such as `Z:`; on POSIX an unmounted disk leaves its mount-point parent behind, so only the two-save rule protects it, and the two saves are not separated by a minimum time), when nothing above it down to the volume root exists, and for a UNC path (`\\server\share`), which is never checked. The file is capped at 8 MiB: when a save would pass it, fully tombstoned records are pruned first; if it still does not fit, the save is refused and the new revisions read 0.
- **digest**: SHA-256 of the file's bytes as the listing last verified them; a read reports the digest of the bytes actually returned. Digests of unchanged files (same file ID, size, mtime and ctime) are reused from `<office dataDir>/harness-digests.json`, a cache of paths and digests (never content) shared by the office and the CLI and kept under 2 MiB (least recently used entries are evicted), so a fresh process does not hash every file again. **Staleness policy:** the cache is a performance aid, not an authority. A cached digest is reused only if the registry has recorded that digest for that element and the file can still be opened for reading; otherwise the file is re-hashed. An edit that preserves the whole identity key (same inode, size, mtime and ctime, which in practice means a same-size rewrite inside the filesystem's timestamp granularity, such as a second or two on FAT or HFS+; restoring an mtime with `utimes` still changes ctime) is invisible to a listing, which keeps showing the previous digest until the file is read or its identity key changes. A read always hashes the bytes it returns; when that differs from the listed digest it repairs the cache entry and the registry's record (a new revision if the content is new), logs once, and the next listing shows the new digest.

A shared element, such as a machine-level skill, has one ID in every project. Assignments reference IDs, and each project's layers are stored separately, so one project changing its assignments, or the shared file changing its content, never changes another project's assignments: both see the same ID at the new revision.

A project element (`el:project:…`) also has one ID in every project that holds the same relative path, but it is a different file in each, so the **global layer may bind only handbook, machine, published and pinned OpenViking elements**; project elements are bound at repository scope or below (task, and the node levels H02 adds). OpenViking counts as the same file everywhere only when **AGENT_OFFICE_OPENVIKING_DIR** is set (the root is pinned for the whole installation). Without it OpenViking is discovered relative to each project, the same `el:openviking:...` ID can be a different checkout in another project, and the namespace is treated like a project element in the global layer. Saving a global binding to either is refused (400, "Project-scoped element in global layer" or "OpenViking element in global layer ... AGENT_OFFICE_OPENVIKING_DIR is not set"). A profile store that already holds one (written before this rule, or by hand) blocks the handoff in every project where that binding is effective (not overridden by a repository or task binding of the same slot), as "unavailable ... in global layer", rather than quietly binding the other project's same-path file.

When a listed element disappears, its registry record stays as a **tombstone**. An assignment that points at it resolves as *missing* (with the last known path, revision, digest and the time it went missing), is refused when saved and blocks a handoff, and is never silently remapped to another file. Only a complete listing of the element's own source instance can tombstone it there, so one project's listing never marks another project's elements as gone; a listing cut short by the discovery bounds, by a folder that could not be read, or by a file whose read was denied or busy (EACCES, EPERM, EBUSY) marks nothing in that source, and the unreadable file is simply not listed until it can be read again (for cached files this is a check that the file can still be opened, not a re-read). An element is tombstoned when it is absent from a complete listing of its source instance, that is, when it disappeared from the publishable catalog: deleted, but also turned binary, grown past 128 KiB, renamed to a credential-like name or otherwise excluded by the filters, even though the file may still exist. An element that is still published in another place resolves as not available here rather than as gone (`missingSince` is set only once it is gone from every place it was listed). If the file comes back at the same place it gets the same ID again, with the number its content has: the same number when the content is the one seen before, a new higher one for new content. `resolve()` describes only namespaces the library publishes, so a non-admin library answers *unknown* for a machine element rather than revealing its title or path. An unreadable registry fails closed: versions read 0, nothing resolves as missing, and the file is left for repair.

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

Open **Inheritance: Global → Repository → Task**. Each layer is a JSON object of named slots:

```json
{
  "rules.quality": { "resource": "guide:testing" },
  "settings.language": { "value": "cs" },
  "tools.browser": null
}
```

- **Global** applies to all repository floors in this office instance. Separate running offices do not share this store.
- **Repository** overrides matching global slots for this floor's checkout; other slots inherit.
- **Task** overrides matching slots for the selected task in that repository. Task IDs from Opora include project, workspace and card, so the same short ID elsewhere cannot collide.
- A missing key inherits. `null` explicitly disables an inherited assignment. Delete the override to inherit again. A binding replaces the whole binding at that key; there is no deep merge or instruction concatenation for the same slot.

Try `{"settings.color":{"value":"red"}}` globally, `blue` for the repository, and `green` for a task. Save each layer and inspect **Effective slots and their origins**. Removing the task override should reveal `blue`, then removing the repository override reveals `red`. Load a task before saving it. Switching scope or reloading discards unsaved edits. A revision conflict requires reloading; stale editors cannot overwrite another user's changes.

For resources, choose a semantic slot and scope in the inheritance editor, collapse it, select a book, click **Assign resource**, and **Save layer**. The first opening loads profiles automatically; the default slot is `rules.quality` at repository scope. Assignment edits and ad-hoc **Add to pack** selections are intentionally separate. Saving a layer persists assignments; exporting a pack does not.

**Resolved handoff preview** shows the exact saved configuration/content to be supplied to a worker, with scope provenance and SHA-256 snapshot digest. Missing or inaccessible resources show a blocking warning. Profiles survive restarts in `<office dataDir>/harness-profiles.json`. Repository identity is the absolute checkout path (case-insensitive on Windows); moving a checkout requires reassigning its repository/task profiles, while the canonical element IDs inside them stay valid; a pre-registry alias (hash of the old absolute path) does not follow the move and resolves as unknown (see Element IDs). Resource IDs are local installation IDs, not portable package names.

## Orchestrator handoff

The Opora planner/router receives these instructions automatically and has `office-harness` on PATH:

```sh
office-harness --catalog
office-harness --effective
office-harness --effective --task 'opora:PROJECT:WORKSPACE:CARD'
office-harness --assign repository assignments.json
office-harness --assign task assignments.json --task 'opora:PROJECT:WORKSPACE:CARD'
```

Use the actual namespaced task IDs returned by `--effective` (components are URL-encoded). `assignments.json` contains `{"revision":N,"layer":{...}}`, with the latest revision and the **complete replacement layer**. Include unchanged slots you want to retain. Configure task requirements before making a card runnable; automatic handout may dispatch ready cards as soon as the orchestrator finishes a turn.

Browser writes require an administrator/shared-password session and same-origin requests. The worker endpoint uses the worker's hook token and derives its repository from that worker, not caller input. Only the active Opora planner/router belonging to an administrator (or shared-password session) may change repository/task layers. Global writes are administrator UI-only. Ordinary workers can inspect their project-scoped effective context but cannot edit profiles or discover administrator machine resources.

Every `OporaBridge.take` path (manual take, autopilot, orchestrator handout) resolves profiles before claiming the card. It reads the selected resources, embeds the manifest and contents in the worker's initial prompt, and fails before claiming if something is unavailable or exceeds the budget. Later profile edits do not change an already seated worker's prompt. Limits: 64 slots per layer, 24 distinct effective resources, 96 KiB resolved handoff, 2 MiB persisted profiles. Invalid saved JSON fails closed and is not overwritten.

This first integration applies to **Opora card dispatch**, not arbitrary direct hires or the unrelated file-planning queue. Scalar settings are **context requirements**, not runtime provider flags: `settings.model` does not change the actual model selection. Resources do not install hooks, execute scripts, connect MCP, start OpenViking, grant tool permissions or override native runner/user instructions. Confirm those capabilities in the selected runner before relying on them.

## Verification

Run `npm run typecheck`, `npm run build` and the full suite `node --import tsx --import=#tests/css --test --test-timeout=120000 tests/*.test.ts` (plain `npm test` has no timeout and can hang on Windows). Focused coverage: `node --import tsx --import=#tests/css --test tests/harness*.test.ts tests/opora.test.ts tests/size.test.ts`. `tests/harness-registry.test.ts` covers the element registry: IDs across a restart and a checkout move, revisions following content, tombstones, shared elements between projects, credential exclusion and the compatibility aliases. `tests/harness-registry-safety.test.ts` injects the interleavings and faults: lock takeover versus a fresh lock, release versus a replacement, a long-held lock, a fenced writer, EACCES and unreachable roots versus the two-listing prune rule, a tampered or oversized digest cache, the OpenViking global rule, a denied file on a warm cache and the revision-history limit. `tests/harness-registry-robustness.test.ts` covers the adverse paths: a project element refused in the global layer and an old global binding blocking the handoff, a read-only registry and the 8 MiB cap (revisions read 0, file untouched), a denied read that tombstones nothing, pruning of deleted checkouts, two processes writing at once, a fresh process reusing the digest cache, aliases after a move, the credential filter on both lists and what `resolve()` tells a non-admin library.

With the isolated office running on 4617, `node tests/harness-office.browser.mjs` tests the **production bundle**, real session/catalog and F8/✕/Esc mouse-look behavior. For the editable visual lab, run Vite on 5187 and `node tests/harness-live.browser.mjs`: this forwards requests to the real authenticated office API, exercises all three layers and restores test settings unless a concurrent edit intervenes. It does not launch paid agents. `HARNESS_OFFICE_URL`, `HARNESS_PASSWORD`, `HARNESS_FLOOR`, `HARNESS_LAB_URL` and `HARNESS_SHOTS` customize these tests. Screenshots default to the OS temporary directory.

![Persisted inheritance editor and scope provenance](images/harness-cascade.png)
