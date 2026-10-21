# Opora process wall

The 3D office has a wide, illuminated **OPORA · Řízení práce** display above the north-wall Issues, Task queue and Pull Requests boards. Aim at it and press **E** or click to open its readable detail window. The wall occupies the upper wall above the existing board labels; it does not replace the task boards or obstruct the floor.

## Views and controls

- **Celý proces** joins queue tasks, workers and PRs using worker identities, PR numbers and branch names. Three prioritized rows fit the physical screen; **Další strana na stěně** cycles additional rows.
- **Pracovníci** filters to rows with an observed worker. **Blokace** shows requests for input, lost worktrees, failed tasks, failed GitHub checks and requested review changes. Selecting these views also changes the physical wall, locally for that viewer.
- The window shows each row's branch, observed phase, head SHA when supplied, checks, review and a GitHub link to inspect the PR evidence. Its phase marker is a projection, not a completed-step checklist.
- **Historie pozorování** keeps the latest 80 changed row observations in browser memory. It clears on a fresh welcome/floor snapshot and page reload. It is not a durable or complete server audit.
- **Podrobný plán · DEMO** embeds the existing [Process Observatory](process-studio.md), including the six-phase pipeline, repository-role form, memory proposal/reuse and replay. It is clearly separated from live office data.
- The top-right **✕** and **Esc** close the window using the office's normal modal/focus lifecycle. Escape also works from the embedded demo; if that demo's own information dialog is open, the first Escape closes that inner dialog.

The small animated spider on each row stays at the observed phase. Its legs move only when the worker reports `working`, the socket is connected and the current snapshot is ready. Reduced-motion preferences suppress that motion. There is no invented automatic advancement when the office is idle, and the wall never launches work or changes a PR.

## Live data and limits

The wall reuses the existing authenticated office connection and store, without another socket or credentials. Worker updates, queue updates and GitHub PR snapshots refresh its projection. Disconnects show **ODPOJENO** and freeze motion; reconnects show **SYNCHRONIZACE** until the floor snapshot arrives. The detail displays the last relevant observation time separately from GitHub's fetch time and errors. GitHub snapshots older than three minutes are flagged as potentially stale.

A worker's `done` means its turn ended, not that tests passed. A test tool call means a check was invoked, not that it succeeded. Passing CI and an approved review still do not mean merged. Only the PR snapshot's `MERGED` state produces the merged phase, and it does not imply deployment.

Opora's external plan, OpenViking memory, releases and deployment are not connected by this change. Their proposed contracts remain in the clearly labeled demo. The live view does not claim complete coverage of background mechanisms or provide elapsed-time comparisons across runs. Durable correlated events and adapters are required for those capabilities.

## Implementation and validation

`src/client/features/process-wall/` owns the pure projection/history model, canvas texture, fixture, modal and subscription lifecycle. The feature joins the main install list and office fixture registry; no global store or protocol additions are needed. It is available on the office map, not on alternate castle/station maps or `/lite`.

Run `npm run typecheck`, `npm test`, and `npm run build`. `tests/process-wall.test.ts` verifies association, blockers, status/evidence distinctions, stale connection labels and bounded history. Visual verification should cover the real 3D fixture, live projection with controlled worker messages, view switching, nested demo Escape, mouse-look restoration, disconnect and mobile detail. Synthetic test messages are browser fixtures, not claims of real agent execution.
