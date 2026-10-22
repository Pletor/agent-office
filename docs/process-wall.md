# Opora live process wall

The 3D office has a wide, illuminated **OPORA · ŽIVÝ PROCES** display above the north-wall Issues, Task queue and Pull Requests boards. Aim at it and press **E** or click to open its window. The wall sits above the board labels; it does not replace the task boards or obstruct the floor.

## The wall

- **Top bar:** how many cards (lanes) there are, how many workers report `working`, how many blockers wait on someone (**čeká na vás**) and how many are failures (**selhalo**); a **ŽIVĚ / ODPOJENO** pill and the age of the last event.
- **Seven phases** (Zadání, Plán, Práce, Kontroly, Revize, Sloučení, Paměť) with how many lanes stand in each.
- **Up to five lanes**, blockers first, then the most recently active. A lane is an Opora card when its events carry one, else the queue task its worker runs, else the worker and its branch, else the PR (a guard on `main` has a lane of its own). Lanes the office already knows about (Opora runs, queued and running tasks, present workers) show before they report anything, with a dashed marker.
- **The marker** (the worker's initials) stands in the phase of the lane's latest event that isn't just information; a memory recall never moves it. Behind it the **trail** shows each phase's last state: confirmed (green), failed (red diamond), waiting (yellow ring), in progress (blue), or passed without an event (dashed).
- **The blocker band:** a worker asking a human, tests or a build that keep failing, failed CI, requested review changes, a red post-merge guard, a refused Opora claim or a failing lease heartbeat. The store's current state wins over an older event (a worker that answered, CI that went green again).

The wall is redrawn only when an event or the office's state arrives, while a marker moves, and when its once-a-second age label reads differently. A marker slides only on a phase change (450 ms), a tool call pulses once, a failure shakes; reduced-motion preferences turn all of that off. **ODPOJENO** means the office socket is down, or workers say they are working while no event has come for five minutes; the lanes then show greyed as the last known state.

## The window

- **Proces:** the blockers as chips (click one to select its lane), the flow map with every lane (rows slide to their new order, held still while the pointer is over the list), and the **card inspector**: who is on turn (a human, when a worker asks), the phase, Opora run, branch and PR link, the checks the events reported (a test call is "spuštěno · výsledek nepotvrzen", not a pass) and the lane's latest events.
- **Události:** the floor's journal, newest first, filterable by card or worker. **Pozastavit čtení** holds the list still while events keep arriving; the button counts the waiting ones and **Pokračovat ve čtení** shows them.
- **Paměť:** memory-phase events from the journal, and the live **OpenViking** read through Opora. Choose a role and a query to recall existing memories, with source URI, origin and retrieval score. An optional project field takes an exact Opora project ID; an office branch/repository name is never silently treated as that identity.
- **Source health** in the header: Kancelář (socket and the age of its last event), Opora (linked, connected, age), GitHub (snapshot age, or its error) and OpenViking (what the Paměť tab last saw).
- The top-right **✕** and **Esc** close the window through the office's normal modal lifecycle, straight back into mouse-look.

There is no invented advancement when the office is idle, and the wall never launches work or changes a PR.

## Live data and limits

The wall reuses the existing authenticated office connection and store, without another socket or credentials. Worker updates, queue updates and GitHub PR snapshots refresh its projection. Disconnects show **ODPOJENO** and freeze motion; reconnects show **SYNCHRONIZACE** until the floor snapshot arrives. The detail displays the last relevant observation time separately from GitHub's fetch time and errors. GitHub snapshots older than three minutes are flagged as potentially stale.

A worker's `done` means its turn ended, not that tests passed. A test tool call means a check was invoked, not that it succeeded. Passing CI and an approved review still do not mean merged. Only the PR snapshot's `MERGED` state produces the merged phase, and it does not imply deployment.

Opora's external plan, releases and deployment do not yet have live event adapters, and the wall shows no modelled or sample data in their place. OpenViking now has real status and recall through the existing Opora API, but no memory-write or learning-event stream. The live view does not claim complete coverage of background mechanisms or provide elapsed-time comparisons across runs. Durable correlated events are required for those capabilities.

## Event journal

Each floor keeps a **process journal**: the last 1000 events of real work on it, in the shape of the `opora.process-event/1` contract (`src/shared/protocol/process.ts`): `id`, a `seq` that only grows, `at`, `source` (`office`, `opora`, `github`), a dotted `kind`, one of seven `phase` columns (intake, plan, work, checks, review, merge, memory), a `state`, a short `title`/`detail`, the `actor`, `refs` (Opora project/workspace/card/execution, worker, floor, branch, PR, SHA, URL) and, for a tool call, `tool`. Ids are `source:<floor>.<boot>:<seq>`, so they don't repeat after a restart.

Where events come from (`src/server/process/`):

- **Workers** (from what the floor already sends browsers, and the providers' tool hook): `turn.start`, `turn.end`, `needs.input`, `worker.status` (other moves, arriving, going home, a lost worktree), `tool.use` for every tool call with its name, action and target (cut to 80 characters), and `tool.use`/`failing` once tests or a build keep failing. A worker on an Opora card carries its card, workspace and execution.
- **Queue:** `queue.task` when a task comes in, is handed out, ends (a finished task is `info`, not a pass) or is taken off. It carries the task's id (`refs.task`), which is how the wall puts it in the task's lane.
- **GitHub board:** `pr.opened`, `pr.checks` (pass/fail/pending moves), `pr.review` (decision changes), `pr.updated`, `pr.merged`, `pr.closed`. A worker's own `gh pr create` is a `pr.opened` at once and makes the floor ask GitHub straight away, instead of on the next 90-second refresh.
- **Opora:** `run.claim` (granted or refused), `run.heartbeat` (only when it starts failing or recovers), `run.release`, `run.result`, `pr.opened`/`pr.handoff` for an execution's pull request, `check.self`, `pr.lens` (a worker's PR Lens diagram on its pull request), `upkeep`, `guard` (once per verdict and head), `pr.review`/`security.review` for review slots and posted reviews, `isolated.stage`, from Opora's own event stream (below) every outbox event as it happens (`lease.*`, `result.reported`, `step.*`, `pr.linked`, `review.*`, `gate.changed`, `formal.result`, `decision.*`, `changeset.*`, `autorebase.*`, `merge.done`, `writeback.done`, `card.closed`, `stage.changed`), and from the canvas the bridge polls: `card.status`, `stage` and `activity`.

Events never carry tokens, lease tokens, passwords, prompt text or paths into the office's data; the floor's checkout folds to `.` and the home folder to `~`.

Each new event goes at once to the browsers on its floor (`process.event`, droppable for a slow link); arriving on a floor brings the latest 300 with it (`FloorView.process`), and `process.since {seq}` catches up (`process.snapshot`). The page keeps the last 300 in the `process` slice, and the wall and its window are built from them. Others read them over HTTP: `GET /api/process/events?floor=<id>&after=<seq>&limit=<n>` (signed in, oldest first).

### Push to Opora

For a floor linked to an Opora project, every event also goes to `POST {AGENT_OFFICE_OPORA_URL}/api/oporahub/process-events` as `{ "events": [...] }`, with the office's usual Opora actor and origin headers: up to 50 at a time, within 250 ms. Only `office` and `github` events of a floor linked to a project and workspace are pushed (Opora refuses its own source). A failed batch is sent again from where it stopped (Opora treats an id it already has as a no-op), with backoff up to 30 s; events Opora refuses for good (per-event `rejected`, or 422 for a whole batch) are logged once and dropped, never retried; the queue holds 2000 and drops the oldest. While Opora answers 404 (no such endpoint yet) the office stays quiet and asks again each minute. None of it can block or fail the office's work. `AGENT_OFFICE_PROCESS_PUSH=0` turns the push off (and Opora's event stream with it).

### Opora's event stream

Each floor linked to an Opora project and workspace follows Canvas's event outbox live: one SSE connection per floor, `GET {AGENT_OFFICE_OPORA_URL}/api/oporahub/events/stream?project=<id>&workspace=<id>` with the office's usual `X-Opora-Actor` (`src/server/process/opora-stream.ts`). A new stream starts at the outbox's `head` (no replay of history), resumes with `Last-Event-ID` (the cursor is kept in memory only, so relinking the same project resumes too), reopens itself at 280 s ahead of Canvas's 300 s per-connection limit, drops a connection that stays silent for 45 s (Canvas sends a heartbeat every 15 s), and backs off 1 s → 30 s while Opora doesn't answer (also on an older Opora without the outbox, which answers 404). A retention `gap` is logged once and the stream carries on.

Each event becomes a process event with `source: opora` (`opora-outbox.ts`): an event carrying Canvas's process fields (`phase`, `state`, `title`, `detail`, `refs`, `tool`) keeps them; a bare one is mapped by its kind (leases and steps to Práce, test/verification steps, `gate.changed` and `formal.result` to Kontroly, `review.*` and `pr.linked` to Revize, `merge.done`/`autorebase.*`/`writeback.done` to Sloučení, `card.closed` to Paměť, `changeset.*` to Plán, `stage.changed` to its stage's column, `decision.created` blocked on a human, `decision.resolved` ok). Events the office pushed itself (`source` `office` or `github`) come back on the stream and are skipped. While the stream is connected, the bridge's poll-derived `card.status`, `stage` and `run.result` are not journaled for that floor, since the stream already said them; `activity` still is. Events with `source: opora` are never pushed back.

The stream's health is in the floor's journal snapshot (`stream: {connected, lastEventAt}`) and in `process.stream` whenever it connects or drops; the wall's **Opora** chip reads it: **živě · age** while it is connected, **stáří · age** (amber) while it is down but the bridge's polls still answer, **odpojeno** when neither does. Floors without a stream (not linked, or turned off) show the chip as before. `AGENT_OFFICE_OPORA_STREAM=0` (or `AGENT_OFFICE_PROCESS_PUSH=0`) turns the stream off. Each stream takes one of Canvas's 8 concurrent stream slots.

Not journaled yet: Opora's plan commits and OpenViking memory writes (they happen inside Opora, which reports them itself), and memory recall from the wall (it isn't tied to a floor).

## Connecting the existing Opora/OpenViking service

Set `OPORA_CONTROL_CENTER_URL=http://127.0.0.1:8740` in the **agent-office server** environment, then start/restart that server. Use your actual Opora port if different. Without this explicit setting the adapter is disabled. The URL must be an HTTP loopback origin without credentials, path, query or fragment. Opora keeps its existing OpenViking address, enablement and role keys; agent-office never reads or returns those keys.

The authenticated `/api/process-memory` and `/api/process-memory/recall` endpoints permit only administrator accounts or the office's shared-password session. This matters because Opora's role memories span projects. Recall also requires the office's Origin header. The server calls only Opora's fixed status, roles and recall endpoints, without redirects or proxies, with response-size bounds and deadlines. Returned fields are explicitly selected. No provisioning, settings, writes or session commits are forwarded.

Status refreshes every 15 seconds while the memory tab is open; leaving it cancels browser requests and polling. Recall runs only when submitted. Results are rendered as text, not instructions or HTML, and remain labeled with the submitted role/query/project. `configured` means Opora reports its memory service configured, not that every lookup succeeds. A recall failure is shown separately. Retrieval scores are not measures of agent quality.

OpenViking must be running independently (the local setup uses Docker and Ollama). If the service is down, Opora's `unavailable` state is shown. Start the existing OpenViking deployment and verify Opora's `/api/memory/status`; do not create replacement role keys merely to make the visualization green.

## Implementation and validation

`src/client/features/process-wall/` owns the feature: `lanes.ts` (the pure mapping of journal + store into lanes, blockers and counts), `live.ts` (live/disconnected and source health), `motion.ts` (the wall's event-driven motion), `texture.ts` and `paint.ts` (the 2048×512 canvas), and the window (`ui.ts`, `flow.ts`, `inspector.ts`, `stream.ts`, `memtab.ts`, `memory.ts`, `ui.css`, `flow.css`). The feature joins the main install list and office fixture registry. The server journal is `src/server/process/` with its protocol domain `process`, WS handler and `process` client slice; `tests/process-journal.test.ts` covers the ring and seq, redaction, hook/board/queue/canvas mappings and the Opora push. It is available on the office map, not on alternate castle/station maps or `/lite`.

Run `npm run typecheck`, `npm test`, and `npm run build`. `tests/process-wall.test.ts` verifies lane keys, phase and trail rules (info events and recalls don't move a marker), store-only lanes, every blocker kind and the store overruling stale events, ordering, liveness, source health and the motion rules. Visual verification should run a separate built office with a temporary home, feed events through the server journal (`processHub.emit`), and screenshot the wall texture, the window's tabs, a narrow viewport, Esc/✕ back to pointer lock, and a disconnect.
