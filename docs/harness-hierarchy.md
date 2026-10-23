# Seven-level Harness inheritance

Optional native regression guardrails appear beside the percentages: affected runs,
incident reports and recorded reverts. These are reasons to review the exact version,
not proof that the tool caused the regression. No recorded association does not imply
measured production success. Reading a warning never changes a checkbox or saved layer.

The library's **Pracovní výbava** editor configures Global → Repository → Page → Layer → Area → Sector → Card. Select the project using the library toolbar. Check a resource to include it, uncheck to disable its effective slots, or choose **Dědit** to remove its local overrides. Every enabled resource shows its origin. **Uložit výbavu** explicitly saves the complete layer; navigating or reloading discards unsaved edits. A rejected save retains the draft. Advanced JSON supports scalar settings and custom named slots. Exporting an ad-hoc context pack is independent of saved assignments.

**Zkušenosti a úspěšnost nástrojů** optionally reads the installed recommendation endpoint. Enter a problem ID from the toolbox and choose **Načíst zkušenosti**. Rows show the exact content-version prefix, separate human-closed and agent-reported counts, unknown outcomes, different-card count and 95% interval. Percentages describe selected-kit associations in this project/workspace; they do not prove actual invocation, causal benefit or future correctness. Missing data stays unknown. Lookup preserves unsaved assignments; changing scope/problem clears old statistics and ignores late responses. A server without the optional endpoint says the feature is unavailable and keeps editing usable. This panel never declares capabilities, applies a proposed kit or saves profiles.

Bind each floor to its currently open Opora project/workspace with **Připojit otevřenou Oporu**. A binding stores the configured server origin, project/workspace IDs and checkout identity. A changed window or server refuses node-level operations until restored or explicitly rebound. Global/repository defaults remain editable while Opora is unavailable. Rebinding preserves old profiles under their original node IDs; it does not copy them to a different project. Separate office instances do not share global storage. Moving a checkout changes its repository identity.

The hierarchy comes from a bounded read of Canvas `/api/view`, not the office's flattened card summary. The outer card above a sector is a page; the inner one is a layer; nested sectors and leaf cards supply sector/card scopes. Areas follow Canvas's same-parent card-centre rule: the smallest containing area wins, with stable canvas order for equal sizes. Moving a sector out of an area changes its inheritance. Comments do not change card roles. Missing parents, cycles, excessive depth and ambiguous intermediate cards are refused. Not every canvas contains every level; selectors show the actual available nodes.

## Agent commands

These commands use the authenticated worker endpoint when hook credentials exist:

```sh
office-harness --hierarchy
office-harness --bind PROJECT WORKSPACE BINDING_REVISION
office-harness --hierarchy --task 'opora:PROJECT:WORKSPACE:CARD'
office-harness --configure task assignments.json --task 'opora:PROJECT:WORKSPACE:CARD'
```

`assignments.json` contains `{"revision":N,"pathDigest":"...","layer":{...}}`. Read both revisions and the exact canonical node keys from `--hierarchy`; `--bind` uses `bindingRevision`. Rebinding additionally requires `--rebind`. Supported configure levels are `repository`, `page`, `layer`, `area`, `sector`, `task`; the administrator UI also owns `global`. A node may be configured only at its own level. Ordinary workers can read project resources; only the active administrator-owned planner/router can configure profiles and bindings. Machine resources and global writes remain restricted. Browser mutations require a same-origin administrator session.

The legacy `--effective` and `--assign repository|task` protocol remains available for custom/unbound task IDs. Bound Opora nodes require the hierarchy protocol for writes, preventing a page being accidentally saved as a leaf task. A global or repository hierarchy read has no node target; node reads infer their own level.

## Storage and handoffs

When a catalog supplies legacy aliases, the checkbox row recognizes those saved assignments as the same resource. Disable and inherit affect all matching slots. Missing-resource rows remain readable even when version metadata is unavailable. Global assignments accept only the handbook and explicitly published `Shared harness` resources; private machine and project files cannot become defaults for all workers.

Version 2 profiles retain old task assignments, lifting them into the corresponding scope when their node becomes a page/layer/area/sector. Saving that scope replaces the lifted layer and retires its migration marker; deleting the override restores normal ancestor inheritance. Old task bytes remain for recovery. Global/repository identity is unchanged. Store updates use revision compare-and-set, file leases and exclusive durable revision publication, so concurrent processes cannot both publish the same revision. Audit entries record actor, scope, node and slot names. Keep the profile/binding files and their revision directories together when backing up or migrating an office. Downgrading to a reader that does not support profile version 2 requires restoring the pre-migration backup; it must not rewrite the new store.

The path digest checks scope/node ancestry before a save and again after acquiring the write lease. A geometry move, deletion or reparenting requires reloading. Resource availability and the 24-resource/96-KiB resolved-context budget are checked before committing. Missing resources can still block later handoffs if files change after saving; this editor does not pin resource versions.

**Context v1:** bound Opora task preparation resolves all seven levels against the current canvas and embeds resource contents with a snapshot digest. An unavailable or changed binding blocks preparation. Already seated workers retain their snapshot. **Context v2:** dispatch continues to use Canvas's immutable accepted assignment; live Harness profiles are not appended. This PR does not add a v2 kit producer, measured outcomes, automatic promotion, Context7 calls or OpenViking writes. Selecting a script/MCP/skill is context configuration, not execution or proof of runner capability.

## Recommendation lifecycle storage

The existing profile revision store can retain scoped tool recommendation state through
its internal `advanceTool` server method. State is isolated by repository, native server
origin, project, workspace and problem. Promotion records an exact content version and
requirements; replacing an incumbent must name its exact baseline and cannot expand
capabilities or change category. Reconciliation can suspend a failing/inconclusive
version or roll back to the retained previous version only after fresh positive evidence
for that exact compatible version. It does not modify manual layers or accepted kits.

Evidence is fetched by a trusted server callback under the existing renewable lock.
The existing revision publication rejects concurrent profile/lifecycle writes. An
authority or transport error publishes nothing; a caller must treat the operation as
unavailable, never use the older stored `stable` label as fresh authorization. The
worker transport and automatic recommendation-selection integration are still pending.
There is no public endpoint accepting caller-supplied eligibility and no autonomous
promotion merely from installing this storage seam. Stable here means a scoped
recommendation policy passed, not demonstrated causal benefit or production permission.

`toolStates` is an optional v2 field. Existing v2 layer writers preserve unknown fields;
v1 migration retains the same legacy task markers. Use the existing whole-store backup
procedure for older writers. State and its bounded transition audit are written with
the manual layers in the same atomic revision, not a second ledger. Restoration must
preserve the matching revision files as described above.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build`. Focused tests cover geometry boundaries, seven-level inheritance, legacy migration, concurrent publication, HTTP authorization, project isolation, stale-path conflicts and actual worker handoff. With Vite on 5192, run `node tests/harness-hierarchy.browser.mjs`; `HARNESS_LAB_URL` and `HARNESS_SHOTS` override the lab and screenshot directory. It checks desktop/mobile selectors, inherited checkboxes, persistence, conflict retention, reload, versioned rates, unsaved-draft retention, stale-response fencing, missing-endpoint behavior and modal close. The fixture writes no live settings and launches no paid agents.
