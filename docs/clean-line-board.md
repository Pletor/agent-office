# Boss Office — Čistá linie

Back to the [README](../README.md). The process it shows is [Čistá linie](cista-linie.md).

The board over the loft's south window (up the stairs, on your right as you come through the door) shows one repository's main line: its commit graph, the merge queue, the line's health and the rules. Aim at it and press **E**. The top-right **✕** or **Esc** closes the window and puts you straight back into mouse-look.

## The wall

**ČISTÁ LINIE**, the repository and its remote main, the newest commits with main and the live branches as lanes, and four counters: **Na řadě** (the green PR at the head of the queue), **Červené** (bad health flags, and PRs with failing checks or conflicts), **K úklidu** (what Uklidit would delete) and **Drift** (the server or client not built from main). It reads `GET /api/cleanline` every 15 seconds while the tab is visible and redraws only when what it shows has changed.

## The window

The buttons at the top switch between the floor's repository and the office's own source (`agent-office`, when the floor is another project).

- **Graf** — the last 120 commits of the remote main (`fork/main` when there's a `fork` remote, else what `main` tracks), plus the commits of every branch and open PR that main doesn't have, laid out like GitHub's or VS Code's Git Graph: main in lane 0, branches beside it, merges and fork points as curves, branch names, PR numbers (from a squash subject's `(#N)`), author and age.
- **Fronta** — the open PRs, in the order they should be merged. Green comes first, oldest first. Green means all of these: based on main, not a draft, the checks have passed, GitHub's merge state is `CLEAN`, and the review hasn't requested changes. The rest follow, nearest to green first, each with its reasons: a chain (`base` isn't main), behind main, a conflict, a draft, failing or running checks, or requested changes. **Sloučit** shows only on the head of the queue, only when it's green.
- **Zdraví** — stacked PRs, branches more than 20 commits behind main, merged branches nobody deleted (local and remote; a squash merge counts when merging the branch would change nothing), orphaned worktrees (no worker, and their branch merged; or detached, on main or with their branch gone, and their HEAD already in main), a dirty main checkout, and for the office's own repository the drift: the running server's commit, the commit `dist` was built from, and the commit of the client bundle (`dist/public/build-info.json`), each against main; a build stamped with uncommitted changes counts as drift too. **Uklidit** is here.
- **Pravidla** — [docs/cista-linie.md](cista-linie.md), as the client was built with it.

## The two buttons

Both are for people only: an admin account or the shared password, from the office's own page (same-origin), each after a confirmation on screen. Every press writes a line (time, who, what, the repository, the outcome) to `cleanline-audit.log` in the office's data folder and to the server's log.

**Sloučit** (`POST /api/cleanline/merge {floor, repo, pr, sha}`). The window sends the head commit it showed. The server reads the open PRs from GitHub again and merges only if that PR is still the head of the queue, still green and still on exactly that commit: `gh pr merge <n> --squash --delete-branch --match-head-commit <sha> --repo <owner/name>`, so a push in between makes GitHub refuse too. It never approves anything. After it, deploy main (server and client) and let the owner tidy up.

**Uklidit** (`GET /api/cleanline/cleanup-plan`, then `POST /api/cleanline/cleanup {floor, repo, items}`). The window shows the exact list first: local branches whose content is in main, their remote copies, and orphaned worktrees, each with why, plus what's kept and why. Only what you leave ticked is sent. The server reads the repository again and deletes an item only if it's still in a fresh plan, unchanged:

- nothing at all when the remote main can't be read;
- never `main`, the branch the repository's own folder has checked out, a branch a seated worker is on, the head branch of an open PR, or a branch whose name is also on another remote (an upstream may have a PR for it);
- on the remote, only branches of PRs merged on the main remote's GitHub repository, and never on `origin` when a `fork` remote exists (`origin` is then someone else's upstream);
- a branch checked out in any worktree only when that worktree goes too, in the same confirmed list, and is clean;
- a worktree only with no uncommitted or untracked changes, no worker, no running process inside it (read on Linux), and nothing in it changed for 24 hours (its top two levels and its index), never the repository's own folder or the office's install;
- before a branch is deleted, its commit is kept under `refs/cleanline-backup/<time>/<branch>` (remote copies under `…/remote/<branch>`, a worktree's HEAD under `…/wt-<folder>`) in that repository, so `git branch <name> refs/cleanline-backup/<time>/<name>` brings it back;
- a worktree's `node_modules`, when it's a junction, is unlinked first (the link itself, never followed or recursed into), then `git worktree remove`; if only Windows' long paths stop git, the folder is deleted by its `\\?\` path and `git worktree prune` runs. If git refuses because of changes, nothing is forced.

## Implementation

Server: `src/server/cleanline/` (`state.ts` reads the repository with the status wall's git helpers, `graph.ts` the log, `queue.ts` the PRs, `health.ts` and `cleanup.ts` are pure rules over what was read, `index.ts` caches reads for 15 s and fetches at most every 5 minutes, `AGENT_OFFICE_STATUS_FETCH=off` turns fetching off). Routes: `src/server/http/routes/cleanline.ts`. The lane layout is `layoutGraph` in `src/shared/cleanline.ts`. Client: `src/client/features/cleanline/`. The Vite build writes the client's stamp to `dist/public/build-info.json`; the 🚦 status wall compares it with main too.

Tests: `node --import tsx --import=#tests/css --test tests/cleanline*.test.ts` (lane layout, queue order and flags, health, the cleanup plan's safety, the merge guard, and a real temporary repository with a squash-merged branch, a worktree and a dirty one).

## Screenshots

[The wall](shots/clean-line/office-wall.png), [Graf](shots/clean-line/window-graf.png), [Fronta with the confirmation](shots/clean-line/window-fronta-confirm.png) (a labeled sample queue: the demo repository has no GitHub), [Zdraví](shots/clean-line/window-zdravi.png), [the Uklidit list](shots/clean-line/window-uklidit-seznam.png) and [its outcome](shots/clean-line/window-uklidit-hotovo.png) on a temporary repository, [Pravidla](shots/clean-line/window-pravidla.png), and [Graf of agent-office](shots/clean-line/window-graf-agent-office.png).
