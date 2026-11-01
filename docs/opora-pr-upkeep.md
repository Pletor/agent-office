# Opora PR upkeep and the post-merge guard

Back to the [README](../README.md) · [execution authority](opora-execution.md) · [configuration](configuration.md#opora-canvas).

The office opens a pull request for each reported Opora execution ([pull request handoff](opora-execution.md#pull-request-handoff)). Two optional loops look after those PRs once they're open, following the same rules: there is no global merge lock, conflicts are fixed by the office before a person notices, post-merge testing is the safety net, and the office never merges anything. Deterministic code runs first; an LLM is only the fallback for textual conflicts. Both are **off by default**.

## PR upkeep (`AGENT_OFFICE_OPORA_UPKEEP=on`)

Every pass (5 minutes by default) the office lists the repository's open pull requests with `gh` and keeps those that are Opora's: a head branch starting `opora/`, or an `Opora-Execution:` trailer line in the body. Pull requests from forks are left alone. For each one:

1. It fetches the base and head into its own refs (`refs/opora-upkeep/…`, never the floor's checkout) and skips the PR when the base is already an ancestor of the head, or when the head moved since `gh` listed it.
2. It rebases the head onto the base in a throwaway detached worktree under `<data dir>/opora-upkeep/trees/`.
3. On a textual conflict it runs a **fresh** headless Claude for each conflicted step: `claude -p --no-session-persistence` with no settings, hooks, MCP servers or plugins, file tools only (`Read,Edit,Write,Grep,Glob`, no shell) and edits accepted only inside the worktree. The office checks no conflict markers are left, stages the files and continues the rebase itself.
4. The configured check command (`AGENT_OFFICE_OPORA_CHECK_COMMAND`) has to pass in the worktree; a red run gets one more try, so a check that failed for the machine's reasons doesn't call anyone. Only then is the branch pushed with `git push --force-with-lease=<branch>:<the head it read>`, so a push someone made in the meantime is never overwritten. A conflict Claude resolved gets a comment on the PR listing the files, to be reviewed.
5. Anything else (the resolver failed or left markers, the checks failed, the LLM fallback is off, more than six conflicted commits) aborts the rebase and comments on the PR with the reason, the conflicted files and the tail of the check output, adds the `opora-needs-human` label (when the repository has it) and stops trying that head commit. A new push to the PR starts afresh. Before it raises that notice, and on any other failure, it asks GitHub where the PR's branch is: when someone else pushed meanwhile (another pass, or another office keeping the same repository, which lost the office a push race once), the pass is skipped instead, with no notice.
6. A later pass that finds the PR up to date with its base, or brings it there, takes an earlier notice back, whoever raised it: it removes the `opora-needs-human` label and rewrites each such comment as *No longer needs a human*, keeping the original folded underneath; the process wall gets *PR #N: člověk už není potřeba*. The Boss Office board never listed these notices (it lists Opora's own human-only decisions), so there is nothing to withdraw there.

7. A PR that is up to date with its base but has confirmed `important` review findings still `open` (Canvas's merge gate blocks it with `open_important_findings`) gets a fix attempt, read from Canvas's `GET /api/oporahub/review-jobs?project&workspace` (the project of the PR's execution, else the floor's linked one). Only once every review job of that very head is `completed` (or `not_required`) and its code review completed: a head still under review may already have them fixed. A fresh headless Claude, launched like the resolver, gets the PR title and the findings (path, line, title, rationale) as quoted JSON data and makes the smallest fix in a throwaway worktree at the head; the office commits it (`fix(review): <title>`, one `Opora-Finding: rf_…` trailer per finding), the check command has to pass, and it is pushed as a fast-forward leased on the head it read, with a comment naming the findings. Canvas's next review round on the new head says whether they're fixed. One head and set of findings gets one fix; a set gets `AGENT_OFFICE_OPORA_UPKEEP_ATTEMPTS` attempts in all (a failed attempt, nothing pushed, or a pushed fix the next round still finds open); after that the PR gets a comment and `opora-needs-human`, kept while those findings stay open. It shares the resolver's hourly budget.

Code: `src/server/opora/pr-upkeep.ts`, the notice and its withdrawal in `upkeep-notice.ts`, the finding fix in `upkeep-fix-findings.ts` and its prompt in `finding-fixer.ts`.

Each head commit gets at most `AGENT_OFFICE_OPORA_UPKEEP_ATTEMPTS` tries, at most `AGENT_OFFICE_OPORA_UPKEEP_PER_PASS` PRs are worked per pass, and resolver runs are capped per rolling hour; a conflict that finds the hour's budget spent waits for a later pass without using up an attempt. Without a check command nothing is pushed.

The check command runs in a fresh worktree, so it has to set itself up: `npm ci && npm test`, say, rather than `npm test` alone.

With `AGENT_OFFICE_OPORA_SELF_CHECKS` set, every head upkeep pushes also gets its self-check evidence run in the rebased worktree and posted to Canvas ([self-check evidence](opora-review-evidence.md#self-check-evidence)).

## Post-merge guard (`AGENT_OFFICE_OPORA_GUARD=on`)

Every pass the guard fetches the base branch (`AGENT_OFFICE_OPORA_GUARD_BRANCH`, default `main`) and reads the check runs on its head with `gh api repos/<repo>/commits/<sha>/check-runs`. A head whose checks all passed is remembered as the last green one. When the head goes red (a check failed, timed out or needs action):

1. It takes the first-parent commits since the last green one (or walks back up to `AGENT_OFFICE_OPORA_GUARD_DEPTH` commits to find one) and bisects them. Each probe uses the check runs GitHub already has for that commit; only where there are none does it run the check command locally at that commit in a throwaway worktree, at most `AGENT_OFFICE_OPORA_GUARD_LOCAL_RUNS` times per bisect. A commit it can't get a result for ends the bisect as inconclusive, with a toast.
2. When the first bad commit is an Opora merge (an `Opora-Execution` trailer in its message, or a pull request from an `opora/` branch or with the trailer, found by `gh api …/commits/<sha>/pulls`), it reverts it on top of the red head (`git revert -m 1` for a merge commit, a plain revert for a squash merge), pushes `opora-revert/<first 12 of the sha>` and opens a revert PR against the base. The commit message and the PR body end with `Opora-Revert-Of: <sha>` and `Opora-Execution: <id>`; the body has a table of every commit probed, its result and whether it came from CI or a local run.
3. A first bad commit that isn't Opora's is only reported. A revert that conflicts with later commits is reported and not retried.

It's idempotent: each red head is bisected once, each bad commit gets one revert PR (remembered in `opora-upkeep/state.json`, and an existing PR for the revert branch is reused), and the revert is never merged by the office. Merge it, or close it if the failure was a flake.

## Logs and when it skips

Each step is a server log line (`[opora] …`), a toast in the office and a line in `<data dir>/opora-upkeep/events.jsonl`. A pass skips cleanly, saying so once, when the floor's `origin` isn't on GitHub or `gh` isn't signed in. Without the `claude` CLI, upkeep still rebases cleanly and leaves conflicts to a human.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENT_OFFICE_OPORA_UPKEEP` | off | `on` turns PR upkeep on. |
| `AGENT_OFFICE_OPORA_GUARD` | off | `on` turns the post-merge guard on. |
| `AGENT_OFFICE_OPORA_CHECK_COMMAND` | none | The shell line that gates a push and probes a commit CI has no result for. A floor can set its own as `checkCommand` in `.agent-office/opora-checks.json`, which wins ([a floor's own checks](opora-review-evidence.md#a-floors-own-checks)). |
| `AGENT_OFFICE_OPORA_CHECK_TIMEOUT_MIN` | 20 | How long one check run may take. |
| `AGENT_OFFICE_OPORA_RESOLVE` | on | `off` leaves every textual conflict to a human. |
| `AGENT_OFFICE_OPORA_RESOLVE_PER_HOUR` | 4 | Resolver and finding-fixer runs started per rolling hour. |
| `AGENT_OFFICE_OPORA_UPKEEP_FIX_FINDINGS` | on | `off` leaves open important review findings to a human (only with upkeep on). |
| `AGENT_OFFICE_OPORA_RESOLVE_TIMEOUT_MIN` | 15 | How long one resolver run may take. |
| `AGENT_OFFICE_OPORA_RESOLVE_MODEL` | Claude Code's | The resolver's `--model`. |
| `AGENT_OFFICE_OPORA_UPKEEP_ATTEMPTS` | 2 | Tries per PR head commit. |
| `AGENT_OFFICE_OPORA_UPKEEP_PER_PASS` | 3 | PRs worked per pass. |
| `AGENT_OFFICE_OPORA_UPKEEP_INTERVAL_MIN` | 5 | Time between passes (the first is a minute after start). |
| `AGENT_OFFICE_OPORA_GUARD_BRANCH` | `main` | The branch the guard watches. |
| `AGENT_OFFICE_OPORA_GUARD_LOCAL_RUNS` | 4 | Local check runs per bisect. |
| `AGENT_OFFICE_OPORA_GUARD_DEPTH` | 40 | First-parent commits the guard looks back. |

Implementation: `src/server/opora/upkeep-runner.ts` (started by the floor's Opora bridge), `pr-upkeep.ts`, `conflict-resolver.ts`, `merge-guard.ts`, `upkeep-config.ts` and `upkeep-tools.ts`; tests: `tests/opora-upkeep.test.ts`.
