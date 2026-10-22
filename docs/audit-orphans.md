# Audit: orphans, unused and non-functional parts

Back to the [README](../README.md).

A read-only audit of the office at `fa9b1d9` (fork/main, 2026-10-23): what nothing calls, what is wired but never runs in the owner's setup, and what the docs promise that the code no longer does. Each item has a verdict: **ODSTRANIT** (remove), **NAHRADIT** (replace, with what), **PONECHAT** (keep, why) or **OVĚŘIT** (what to check before deciding). Nothing was changed but this file.

How it was checked:

- `npx -y knip@5` twice: once with every entry point and the tests (`src/server/cli.ts`, `ptyhost.ts`, `opora/execution-worker.ts`, `opora/review-eval-cli.ts`, `harness/catalog.ts`, the five Vite pages, `src/client/lab/*`, `bin/*.js`, `tests/*.test.ts`, `tests/*.browser.mjs`, `vite.config.ts`), and once with `--production` (no tests), so a test-only module shows up as unused.
- A script over `src/shared/protocol/*.ts` listing every `ClientMsg`/`ServerMsg` `t`, then searching `src/client` and `src/server` for a sender and a consumer.
- Every route in `src/server/http/routes/*` and hook path in `src/server/hooks/server.ts`, searched for a caller in `src/client`, `bin/`, `src/server/tunnel` and in Opora Canvas (`canvas-audit`).
- The store's `Topics` (core and slices) against `store.on('<topic>')`; `interactions.define` kinds against what produces them.
- The Opora switches in `src/server/opora/*` against `docs/configuration.md` and `spustit-kancelar.ps1`, and the owner's floor state in `~/agent-office/Pletor/*/.agent-office/` (read only).
- `npm run typecheck`, the test suite, a TODO/FIXME grep, doc links to files, and `tests/size.test.ts`.

## Summary

| # | Item | Kind | Evidence | Verdict | Proposed PR |
|---|---|---|---|---|---|
| 1 | `src/server/opora/sketches.ts` (66 lines) | orphan module | knip `--production`: unused file; only importer `tests/opora.test.ts:14` (`oporaCardViews`); callers removed in `09d9b08` (#26), and `tests/opora.test.ts:424` asserts drawing/storyboard are *not* fetched | NAHRADIT or ODSTRANIT (owner) | B4 |
| 2 | Prompts `opora.card` and `opora.design` | dead config | `src/shared/prompts.ts:424-459`; 0 references to either id outside `prompts.ts` (all other ids have ≥1); the Take path builds its prompt in `opora/execution-prompt.ts:16-38` | NAHRADIT or ODSTRANIT (owner) | B4 |
| 3 | Docs on design cards / designers' brief | docs ≠ code | `README.md:46`, `docs/features.md:60`, `docs/configuration.md:88-101`, `docs/agents.md:90` describe the designer brief and sketch line that #26 removed | NAHRADIT (doc fix with B4) | B4 |
| 4 | `oporaAgentName` | orphan export | `src/shared/opora.ts:116`, no caller since `09d9b08` | ODSTRANIT | B1 |
| 5 | `floorMenuOpen`, `closeFloorMenu` | unused exports | `src/client/ui/floormenu.ts:25,29`, no caller | ODSTRANIT | B1 |
| 6 | `BEST_ROUND`, `roomToGrow`, `SPAWN`, `SCOPE_LEVELS` | unused exports | `src/shared/bargames.ts:134`, `floorplan.ts:87`, `layout.ts:280`, `opora-scope.ts:19`; no reference anywhere | ODSTRANIT | B1 |
| 7 | `OFFICE_NAV` | unused export with load-time cost | `src/shared/nav.ts:330` builds the level-0 nav grid at import; only a comment names it (`shared/maps/types.ts:257`) | ODSTRANIT | B1 |
| 8 | `StepResult`, `OpenCodeHookEvent` | unused exported types | `opora/plan-steps.ts:15`, `opencode.ts:24` (used in-file only) | ODSTRANIT the `export` | B1 |
| 9 | `validateCodexHook`, `validateGrokHook`, `validateMuseHook` | test-only aliases | knip `--production`; only `tests/{codex,grok,muse}.test.ts` call them; production uses `normalize…Hook` | ODSTRANIT (tests call `normalize…`) | B2 |
| 10 | `screens` store topic | event nobody listens to | fired at `src/client/state/core.ts:118`; no `store.on('screens')`; the laptop polls `store.screens` each frame (`features/workers/views.ts:313`) | PONECHAT (harmless, a cheap hook for a listener) | — |
| 11 | `EveryHandleGiven` | "unused" type | `world/office/build.ts:98` is a compile-time completeness check | PONECHAT | — |
| 12 | `mountWhiteboard`, `renderPreview` | knip false positive | used through dynamic import (`features/whiteboard/ui.ts:81,138`) | PONECHAT | — |
| 13 | `/api/opora/isolated-executors/*` + isolated broker (~1.6k lines: `opora/isolated-*.ts`, `opora/executors/*`, `http/routes/isolated-executors.ts`) | feature never run by owner | no caller in `src/client`, `bin/`, Opora; needs `AGENT_OFFICE_OPORA_MANAGED_*`, `ANTHROPIC_API_KEY`, `AGENT_OFFICE_OPORA_OBSERVER_*` (`opora/isolated-config.ts:10-13`), none in `spustit-kancelar.ps1` | OVĚŘIT (owner: keep opt-in, or retire) | — |
| 14 | `GET /api/process/events` | route without caller | `http/routes/process.ts:9-22`; no caller in client, bin or Opora (Canvas only frames the office: `backend/app/embed_origins.py`); session auth, so Opora can't call it as is | OVĚŘIT (planned for Opora?) | — |
| 15 | Opora review workers | enabled, never ran | `AGENT_OFFICE_OPORA_REVIEWS=on` in the launch script; no `opora-reviews/posted.json` on any floor; Canvas review-job tables empty | OVĚŘIT (see below) | — |
| 16 | Opora executions (Take, hand-out, autopilot), auto-PR, self-checks, PR Lens | enabled, never ran | `opora.json` on all three floors: `"runs": []`, `"autopilot": false`; no `opora-executions/`, no `opora-self-checks.json` | OVĚŘIT (see below) | — |
| 17 | PR upkeep / guard | enabled, ran idle | `opora-upkeep/state.json` `"prs": {}` everywhere; one failed pass on Tajemstvi-opory (`events.jsonl`, Go runtime crash text from a CLI) | OVĚŘIT (the failed pass) | — |
| 18 | Launch script's last start | non-functional run | `office-4600.log` is 0 bytes; `office-4600.log.err` (2026-10-22 23:50) holds one line: "Název souboru či adresáře nebo jmenovka svazku je nesprávná" | OVĚŘIT | — |
| 19 | Non-Claude providers (codex, cursor, grok, muse, opencode, pi, dsh, custom) | not used by owner's agents | launch passes `--agent claude`; every floor still gets `agent-office-{codex,cursor,grok,muse}-hook.cjs`, `opencode.mjs`, `pi-extension.mjs` | PONECHAT (upstream feature, per-worker choice) | — |
| 20 | `src/client/lab/*`, `tests/*.browser.mjs`, `generals-hide-ads.user.js` | not in build / not in `npm test` | knip lists them unused; they are dev pages (`blender/README.md`), manual browser checks (`docs/harness.md:129`, `docs/features.md:90-107`) and a downloadable public file | PONECHAT | — |
| 21 | `tests/harness.browser.mjs` | undocumented check | not named in any doc (`harness-office/-live/-screens` are) | NAHRADIT (one line in `docs/harness.md`) | B3 |
| 22 | Size ceilings | no headroom | 13 of 15 `CEILINGS` files are exactly at their ceiling; `world/sky.ts` 965/966, `features/dog/world.ts` 700/702 | NAHRADIT (lower those two ceilings) | B3 |

Protocol, routes and topics otherwise came out clean: all 125 `ClientMsg` types have a sender in `src/client` (and a handler, which the typecheck enforces), all 76 `ServerMsg` types have a sender and a client consumer (`plan` is taken by the `floorPlan` slice's unquoted `plan(s, m)` key), every other HTTP route has a caller, and every store topic but `screens` has a listener. knip found no unused dependencies. No TODO/FIXME/XXX/HACK in `src`, `bin` or `tests`.

## 1-3. The design-card path #26 left behind

Before PR #26 (`09d9b08`, "execute accepted plans with isolated broker"), **▶ Take** filled the `opora.card` prompt, and for a card on the design pipeline prepended the `opora.design` brief with what `readSketches` found and the card's drawing/storyboard pages. #26 replaced that with `executionPrompt` (`opora/execution-prompt.ts`), which hands the worker only the immutable Canvas assignment. The diff removed these lines from `bridge.ts`:

```
-import { describeSketches, oporaCardViews, readSketches, sketchesLine } from './sketches.js';
-    const sketches = await readSketches(this.client, project.id, workspace, card.id);
-    const design = card.group === 'design' ? fillPrompt(this.events.prompt('opora.design'), …
-    const prompt = fillPrompt(this.events.prompt('opora.card'), {
```

What is left: `sketches.ts` (no production importer), the two prompts (still listed and editable under ⚙️ Settings → 🤖 Workers → 📝 Edit the prompts, but editing them changes nothing), and four docs that still promise the designer's brief. A design card still goes to a *Design* desk (`bridge.ts:273` toasts "(design)"), but its worker gets the generic execution prompt.

Owner decision:

- **NAHRADIT**: if designers should still see the sketches, put the design brief back into the execution prompt (e.g. append `fillPrompt(prompt('opora.design'), …)` when the assignment's card is on the design pipeline, built from the immutable assignment rather than a live read), keep `sketches.ts`, and fix the docs to say which part comes from Canvas.
- **ODSTRANIT**: otherwise remove `sketches.ts`, the `oporaCardViews` test (`tests/opora.test.ts:14,409-413`) and the now-pointless `/api/drawing`, `/api/storyboard` fakes (`tests/opora.test.ts:149-153`), drop `opora.card` and `opora.design` from `PROMPTS`, and rewrite the four doc passages. Saved `prompts.json` overrides for those ids must be ignored, not rejected (none exist in the owner's office: `~/agent-office/.agent-office/` has no `prompts.json`).

## 13-17. Opora integration in the owner's setup

What `spustit-kancelar.ps1` turns on, against what actually ran (floor state read on 2026-10-23; all Canvas `opora_*` tables are empty per the brief):

| Path | Switch (default) | Owner's launch | Ran? | Evidence |
|---|---|---|---|---|
| Card execution (Take, hand-out, autopilot) | always on; hand-out on, autopilot off | — | **never** | `opora.json`: `runs: []`, `autopilot: false` on all three floors; no `opora-executions/` dir |
| Auto-PR after a run | `AGENT_OFFICE_OPORA_AUTO_PR` (on) | `on` | **never** (needs a run) | no run to hand off |
| Self-checks on PR heads | `AGENT_OFFICE_OPORA_SELF_CHECKS` (off) | set | **never** | no `opora-self-checks.json` |
| PR Lens instructions | `AGENT_OFFICE_OPORA_PR_LENS` (on) + `AGENT_OFFICE_PR_LENS_HOME` | home set | **never** (prompt-only) | no run |
| Review workers | `AGENT_OFFICE_OPORA_REVIEWS` (off) | `on`, 2 parallel, 12/h | ticks, **no job ever** | no `opora-reviews/posted.json`; Canvas review-job table empty |
| PR upkeep | `AGENT_OFFICE_OPORA_UPKEEP` (off) | `on` | idle passes | `opora-upkeep/state.json` `prs: {}`; 1 failed pass (Tajemstvi-opory) |
| Conflict resolver (LLM) | `AGENT_OFFICE_OPORA_RESOLVE` (on) | — | **never** (needs an upkeep conflict) | `prs: {}` |
| Main guard (bisect/revert) | `AGENT_OFFICE_OPORA_GUARD` (off) | `on` | ran | `lastGreen` set on one floor, `reverts: {}` |
| Process push / stream to Canvas | `AGENT_OFFICE_PROCESS_PUSH`, `_OPORA_STREAM` (on) | — | on (not verified here) | `process/install.ts:43-46` |
| Isolated broker | needs `AGENT_OFFICE_OPORA_MANAGED_*` etc. (off) | not set | **never** | `isolated-config.ts:10-13` returns `null` |
| REA | `AGENT_OFFICE_REA` | `opora` | on (not verified here) | `rea/index.ts` |

So the review, upkeep-resolver, auto-PR, self-check and PR Lens code is reachable and enabled, but downstream of an execution that has never happened: the chain starts at **▶ Take**/hand-out/autopilot, and every floor's `runs` is empty. To check (OVĚŘIT):

1. Take one card by hand on a linked floor and watch `opora.json` `runs`, `opora-executions/<id>-assignment.json` and the PR. If Take fails, that is the real blocker for items 15-17.
2. Canvas side: is `OPORA_REVIEW_JOBS=1` set for the running Opora (the script only sets it for an Opora the office starts)?
3. The failed upkeep pass (`events.jsonl`, 2026-10-22 15:03): the message is a Go stack trace, most likely `gh` crashing; run `gh pr list` from that floor's checkout.
4. The last launch (item 18): the stderr line is Windows' "invalid file name or volume label" and the office never logged. Check `mise where node@22.23.3` output for stray characters and that `office-4600.log` gets written on the next start.
5. Isolated broker: decide whether it stays as an opt-in API (documented in `docs/opora-isolated-execution.md`, with its own tests) or is retired. It is not dead code in the sense of unreachable, only unused by this owner, so it is not in a safe batch.
6. `/api/process/events`: documented in `docs/process-wall.md:46` for "Opora, scripts", but Canvas doesn't call it and it needs a browser session. Either give Opora a way in (hook token) or say it is for signed-in scripts.

## Checks run

- `npm run typecheck`: exit 0.
- Tests: plain `npm test` hangs on Windows in `tests/dsh.test.ts` (stopped after 7 min, at test 247). Re-run as `node --import tsx --import=#tests/css --test --test-timeout=120000 tests/*.test.ts`: 964 tests, 898 pass, 62 fail, 3 cancelled, 1 skipped. Every failure is in the known Windows-only group (DSH/ACP, clone, workers, repos, providers' launch tests, `docs/maps/*.json` loading, `install.sh`, a symlink `EPERM` in `codex-usage`, plus `jukebox-routes` and `server-dispatch` timing out as whole files). None is in the opora, harness, process, cleanline, boss-attention or size tests. The 2026-10-20 baseline was 60 failures of 751; this audit found nothing it could tie to dead code.
- `tests/size.test.ts`: passes; see item 22.
- Doc links to repo files: all resolve, except `docs/oporahub-*.md` in `opora-execution.md:62`, `opora-review-evidence.md:3` and `opora-review-workers.md:5`, which name files in Opora Canvas (they exist there), so not broken.

## Safe to remove now

Each batch is one small PR from fresh `fork/main`; none touches behaviour, a registry or `main.ts`. Run `npm run typecheck`, `npm test`, `npm run build` (and knip `--production` again) on each.

**B1: drop unused exports** (`chore: drop unused exports`)

- `src/shared/opora.ts`: delete `oporaAgentName` (lines 115-118).
- `src/client/ui/floormenu.ts`: delete `floorMenuOpen` and `closeFloorMenu` (keep `current`, `toggleFloorMenu` uses it).
- `src/shared/bargames.ts`: delete `BEST_ROUND`; `src/shared/floorplan.ts`: delete `roomToGrow`; `src/shared/layout.ts`: delete `SPAWN`; `src/shared/opora-scope.ts`: delete `SCOPE_LEVELS`.
- `src/shared/nav.ts`: delete `OFFICE_NAV` (saves building a nav grid at import) and update the comment at `src/shared/maps/types.ts:257` to name `officeNav(level)`.
- `src/server/opora/plan-steps.ts`: `StepResult` and `src/server/opencode.ts`: `OpenCodeHookEvent` become non-exported.
- Why safe: `grep -rn` finds no reference in `src`, `tests`, `bin` or `docs`; the typecheck proves it. Tests: none to change.

**B2: test-only hook aliases** (`test: check hooks through normalize…Hook`)

- `src/server/{codex,grok,muse}.ts`: delete `validate…Hook`.
- `tests/{codex,grok,muse}.test.ts`: assert `normalize…Hook(…) === undefined` (or falsy) instead.
- Why safe: production never calls them (knip `--production`).

**B3: housekeeping** (`chore: tighten size ceilings, name the harness lab check`)

- `tests/size.test.ts`: lower `src/client/world/sky.ts` to 965 and `src/client/features/dog/world.ts` to 700 (as `docs/code-layout.md` asks when a listed file shrinks).
- `docs/harness.md`: one sentence for `tests/harness.browser.mjs` (Vite on 5187, real catalog), next to the other three checks.

**B4: the design-card leftovers** (only after the owner picks NAHRADIT or ODSTRANIT in section 1-3)

- ODSTRANIT: `src/server/opora/sketches.ts`; `opora.card` and `opora.design` in `src/shared/prompts.ts`; `tests/opora.test.ts` lines 14, 149-153 and the `oporaCardViews` test (409-413); doc passages in `README.md:46`, `docs/features.md:60`, `docs/configuration.md:88-101`, `docs/agents.md:90`. Check `tests/prompts.test.ts` still passes (it walks `PROMPTS`).
- NAHRADIT: wire the design brief into `executionPrompt` with a test in `tests/opora-execution.test.ts`, and fix the same docs to match.

Not in any batch: items 13-19 need the owner's answer or a live check first; items 10-12 and 20 stay.
