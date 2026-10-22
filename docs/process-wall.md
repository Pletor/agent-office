# Opora process wall

The 3D office has a wide, illuminated **OPORA · Řízení práce** display above the north-wall Issues, Task queue and Pull Requests boards. Aim at it and press **E** or click to open its readable detail window. The wall occupies the upper wall above the existing board labels; it does not replace the task boards or obstruct the floor.

## Views and controls

- **Celý proces** joins queue tasks, workers and PRs using worker identities, PR numbers and branch names. Three prioritized rows fit the physical screen; **Další strana na stěně** cycles additional rows.
- **Pracovníci** filters to rows with an observed worker. **Blokace** shows requests for input, lost worktrees, failed tasks, failed GitHub checks and requested review changes. Selecting these views also changes the physical wall, locally for that viewer.
- The window shows each row's branch, observed phase, head SHA when supplied, checks, review and a GitHub link to inspect the PR evidence. Its phase marker is a projection, not a completed-step checklist.
- **Historie pozorování** keeps the latest 80 changed row observations in browser memory. It clears on a fresh welcome/floor snapshot and page reload. It is not a durable or complete server audit.
- **OpenViking · živě** reads the real memory status and role registry through Opora. Choose a role and a query to recall existing memories, with source URI, origin and retrieval score. An optional project field takes an exact Opora project ID; an office branch/repository name is never silently treated as that identity.
- The top-right **✕** and **Esc** close the window using the office's normal modal/focus lifecycle.

The small animated spider on each row stays at the observed phase. Its legs move only when the worker reports `working`, the socket is connected and the current snapshot is ready. Reduced-motion preferences suppress that motion. There is no invented automatic advancement when the office is idle, and the wall never launches work or changes a PR.

## Live data and limits

The wall reuses the existing authenticated office connection and store, without another socket or credentials. Worker updates, queue updates and GitHub PR snapshots refresh its projection. Disconnects show **ODPOJENO** and freeze motion; reconnects show **SYNCHRONIZACE** until the floor snapshot arrives. The detail displays the last relevant observation time separately from GitHub's fetch time and errors. GitHub snapshots older than three minutes are flagged as potentially stale.

A worker's `done` means its turn ended, not that tests passed. A test tool call means a check was invoked, not that it succeeded. Passing CI and an approved review still do not mean merged. Only the PR snapshot's `MERGED` state produces the merged phase, and it does not imply deployment.

Opora's external plan, releases and deployment do not yet have live event adapters, and the wall shows no modelled or sample data in their place. OpenViking now has real status and recall through the existing Opora API, but no memory-write or learning-event stream. The live view does not claim complete coverage of background mechanisms or provide elapsed-time comparisons across runs. Durable correlated events are required for those capabilities.

## Event journal

Each floor keeps a **process journal**: the last 1000 events of real work on it, in the shape of the `opora.process-event/1` contract (`src/shared/protocol/process.ts`): `id`, a `seq` that only grows, `at`, `source` (`office`, `opora`, `github`), a dotted `kind`, one of seven `phase` columns (intake, plan, work, checks, review, merge, memory), a `state`, a short `title`/`detail`, the `actor`, `refs` (Opora project/workspace/card/execution, worker, floor, branch, PR, SHA, URL) and, for a tool call, `tool`. Ids are `source:<floor>.<boot>:<seq>`, so they don't repeat after a restart.

Where events come from (`src/server/process/`):

- **Workers** (from what the floor already sends browsers, and the providers' tool hook): `turn.start`, `turn.end`, `needs.input`, `worker.status` (other moves, arriving, going home, a lost worktree), `tool.use` for every tool call with its name, action and target (cut to 80 characters), and `tool.use`/`failing` once tests or a build keep failing. A worker on an Opora card carries its card, workspace and execution.
- **Queue:** `queue.task` when a task comes in, is handed out, ends (a finished task is `info`, not a pass) or is taken off.
- **GitHub board:** `pr.opened`, `pr.checks` (pass/fail/pending moves), `pr.review` (decision changes), `pr.updated`, `pr.merged`, `pr.closed`. A worker's own `gh pr create` is a `pr.opened` at once and makes the floor ask GitHub straight away, instead of on the next 90-second refresh.
- **Opora:** `run.claim` (granted or refused), `run.heartbeat` (only when it starts failing or recovers), `run.release`, `run.result`, `pr.opened`/`pr.handoff` for an execution's pull request, `check.self`, `upkeep`, `guard` (once per verdict and head), `pr.review`/`security.review` for review slots and posted reviews, `isolated.stage`, and from the canvas the bridge polls: `card.status`, `stage` and `activity`.

Events never carry tokens, lease tokens, passwords, prompt text or paths into the office's data; the floor's checkout folds to `.` and the home folder to `~`.

Each new event goes at once to the browsers on its floor (`process.event`, droppable for a slow link); arriving on a floor brings the latest 300 with it (`FloorView.process`), and `process.since {seq}` catches up (`process.snapshot`). The page keeps the last 300 in the `process` slice, and the wall's history tab shows them. Others read them over HTTP: `GET /api/process/events?floor=<id>&after=<seq>&limit=<n>` (signed in, oldest first).

### Push to Opora

For a floor linked to an Opora project, every event also goes to `POST {AGENT_OFFICE_OPORA_URL}/api/oporahub/process-events` as `{ "events": [...] }`, with the office's usual Opora actor and origin headers: up to 50 at a time, within 250 ms. A failed batch is sent again from where it stopped (Opora treats an id it already has as a no-op), with backoff up to 30 s; the queue holds 2000 and drops the oldest. While Opora answers 404 (no such endpoint yet) the office stays quiet and asks again each minute. None of it can block or fail the office's work. `AGENT_OFFICE_PROCESS_PUSH=0` turns the push off.

Not journaled yet: Opora's plan commits and OpenViking memory writes (they happen inside Opora, which reports them itself), and memory recall from the wall (it isn't tied to a floor).

## Connecting the existing Opora/OpenViking service

Set `OPORA_CONTROL_CENTER_URL=http://127.0.0.1:8740` in the **agent-office server** environment, then start/restart that server. Use your actual Opora port if different. Without this explicit setting the adapter is disabled. The URL must be an HTTP loopback origin without credentials, path, query or fragment. Opora keeps its existing OpenViking address, enablement and role keys; agent-office never reads or returns those keys.

The authenticated `/api/process-memory` and `/api/process-memory/recall` endpoints permit only administrator accounts or the office's shared-password session. This matters because Opora's role memories span projects. Recall also requires the office's Origin header. The server calls only Opora's fixed status, roles and recall endpoints, without redirects or proxies, with response-size bounds and deadlines. Returned fields are explicitly selected. No provisioning, settings, writes or session commits are forwarded.

Status refreshes every 15 seconds while the memory tab is open; leaving it cancels browser requests and polling. Recall runs only when submitted. Results are rendered as text, not instructions or HTML, and remain labeled with the submitted role/query/project. `configured` means Opora reports its memory service configured, not that every lookup succeeds. A recall failure is shown separately. Retrieval scores are not measures of agent quality.

OpenViking must be running independently (the local setup uses Docker and Ollama). If the service is down, Opora's `unavailable` state is shown. Start the existing OpenViking deployment and verify Opora's `/api/memory/status`; do not create replacement role keys merely to make the visualization green.

## Implementation and validation

`src/client/features/process-wall/` owns the pure projection/history model, canvas texture, fixture, modal and subscription lifecycle. The feature joins the main install list and office fixture registry. The server journal is `src/server/process/` with its protocol domain `process`, WS handler and `process` client slice; `tests/process-journal.test.ts` covers the ring and seq, redaction, hook/board/queue/canvas mappings and the Opora push. It is available on the office map, not on alternate castle/station maps or `/lite`.

Run `npm run typecheck`, `npm test`, and `npm run build`. `tests/process-wall.test.ts` verifies association, blockers, status/evidence distinctions, stale connection labels and bounded history. Visual verification should cover the real 3D fixture, live projection with controlled worker messages, view switching, mouse-look restoration, disconnect and mobile detail. Synthetic test messages are browser fixtures, not claims of real agent execution.
