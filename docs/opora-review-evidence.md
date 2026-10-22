# Security reviews, self-check evidence, PR Lens diagrams, the reviewer eval and isolated PRs

Back to the [README](../README.md). Builds on the [review workers](opora-review-workers.md), the [pull request handoff](opora-execution.md#pull-request-handoff) and [PR upkeep](opora-pr-upkeep.md). The Canvas side is in Opora Canvas's `docs/oporahub-review-jobs.md` ("Druh úlohy (`kind`)", "Důkaz vlastních kontrol") and `docs/oporahub-review-identity.md` ("Jak eval spustit").

## Security review jobs

Canvas's review jobs carry `job.kind`: `code` (the code review the workers always did; a Canvas without `kind` means this) or `security`, a separate blocking review Canvas queues for risky or security-sensitive heads. Claiming doesn't change: the same `POST /claim` hands out slots of both kinds, and the office picks the prompts from `task.job.kind`:

- **`security` finders** hunt only for exploitable vulnerabilities in the diff: missing or bypassable authentication and authorization (IDOR, trusting client identity), injection (SQL, shell, template, header, prompt into acting tools), secrets and tokens leaking into logs, responses, prompts or the repository, path traversal, SSRF and open redirects, unsafe deserialization or evaluation, weak or misused cryptography, and risky dependency, CI workflow and schema changes. Not style or general bugs. Each finding needs an exploit scenario. Canvas's `job.risk.securityReasons` go into the prompt as data.
- **`security` voters** confirm only a vulnerability with a credible exploit at `headSha` that nothing on the path already stops.
- Fingerprints of security findings start with `security:` (`security:<bug class>:<hash>`), as Canvas recommends, so they never collide with a code finding.
- **An unknown kind** is never reviewed with a guessed prompt: the slot is released (`/release`) without a model run and the server log says which kind it was.
- On GitHub a completed security job is posted as **🔒 Opora automated security review**, each finding tagged `**[security · <severity>]**`.

Lease, heartbeat, release, submit, the answer's shape, votes, severities and de-duplication are the same for both kinds. Code: `src/server/opora/review-kinds.ts` (prompts and selection), `review-slot.ts`.

## Self-check evidence

Canvas's merge gate wants evidence that the agent ran the required checks (by default `tests` and `build`) on the PR's **current head**. The office runs them and posts `POST /api/oporahub/review-jobs/self-checks` with `{project, workspace, executionId, selfChecks: {headSha, checks: [{name, command, exitCode, status, summary?, output?, durationSeconds?}]}}`, shaped exactly as Canvas validates it: `passed` only for exit code 0, `failed` for any other (a command that couldn't start is 127, a timeout 124), `output` the last 4000 characters, `summary` the last line (≤500). It's the agent's claim, not independent verification.

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENT_OFFICE_OPORA_SELF_CHECKS` | off | The checks: a JSON object (`{"tests":"npm test","build":"npm run build"}`) or one `name=command` per line. Names are Canvas's (`[a-z0-9][a-z0-9_.:-]{0,63}`); use the names in Canvas's `self_checks.required`. |
| `AGENT_OFFICE_OPORA_SELF_CHECK_TIMEOUT_MIN` | `20` | Minutes one check may run (1–120). |

They run, one at a time, in the platform shell:

- **When the office hands off a pull request** (a card worker's, from its worktree, after the PR is opened or reused; the lease isn't held for it), and for an isolated run's PR (below), in its throwaway worktree.
- **On every new head PR upkeep pushes**, in the rebased worktree before it's removed, for the execution the PR body names (`Opora-Execution:`), in the scope that execution was claimed in.

Each (execution, head) is run and posted once; `.agent-office/opora-self-checks.json` remembers it across restarts. Canvas answering 404 (no self-check endpoint) is logged and not retried. A 409 (not the PR's current head yet, or a different record for that head already) gets the same evidence posted again every 30 seconds for 10 minutes, without running the checks again: Canvas learns a head PR upkeep pushed only at its next reconciliation read of the PR (every 5 minutes), so the first post right after the push is refused. Still refused after that, it's logged and left.

A worker may also put `selfChecks` into its own result (`POST …/executions/{id}/results`), and the prompt says how. The result helper passes it on only if it matches the same shape; anything else is left out of the result (with a note on stderr), never the whole result refused.

Code: `src/server/opora/self-checks.ts`, wired in `execution-dispatch.ts`, `pr-upkeep.ts` (`pushed`), `isolated-pull-request.ts` and `execution-worker.ts`.

## PR Lens diagrams

Canvas's `docs/cista-linie.md` §4: the worker that made a change draws it with [PR Lens](https://github.com/coldteadotai/pr-lens) (MIT), so review sees the change's reach and data flow, not just the diff. The **spec** (the validated graph document: lanes, cards with their files and line ranges, edges, flow steps with payloads) is the source of truth that agents (the reviewer, the next worker, the planner) read as data. Everything runs locally: no PR Lens GitHub App, no `analyze` with a model key, no `canvas push` ("subscription, not API"). The office publishes no images and creates **no GitHub side branches** (`pr-lens/<branch>` would be orphan branches, against the clean-line rules): the interactive view lives in Opora (card, then Lens).

- **The worker** is told in its execution prompt to write the graph document of its diff to `.pr-lens/graph.json`, run `validate` until it passes and `render … --theme light --out .pr-lens/render` (render only exists to produce `.pr-lens/render/drawn.graph.json`, the spec with the `.github/pr-lens.yml` corrections applied), and never run `analyze`, `canvas` or `auth`. A worker that can't run the CLI skips it; it never blocks the result.
- **The CLI** is `AGENT_OFFICE_PR_LENS_CLI` when set; otherwise the pinned install at `P:\0. OSVC\8. Code\07. Aplikace\02.Opora-control-center\tools\pr-lens\node_modules\.bin\pr-lens` when it exists; otherwise `npx -y -p @coldtea/pr-lens-cli@0.13.2 -p @coldtea/pr-lens-renderer@0.3.2 pr-lens` (renderer 0.3.3 was published with a `workspace:*` dependency npm can't install).
- **`.pr-lens/` never reaches the PR.** The office adds `.pr-lens/` to the repository's local `info/exclude` when it seats a worker in a new worktree, the office itself never commits (the worker does, and the brief says never to `git add` it or the `.gitignore` line the CLI adds).
- **The handoff** reads `.pr-lens/render/drawn.graph.json` (must be `kind: graph`) after pushing the branch. It then (1) sends the spec to Canvas and (2) puts a short text summary in the PR: title, summary, the added, changed and removed cards with their file paths, the flows' names, and the line "Interaktivní pohled: Opora → karta → Lens". The summary is the body's `## PR Lens` section before the trailers, or a comment on a reused PR. No images.
- **Canvas** gets `POST /api/oporahub/review-jobs/lens` with the execution's credentials like every execution post (`project`, `workspace`, `token` (the lease token), `epoch` in the body, plus `executionId`) and `lens: {prNumber, headSha, validatedAt, specSha256, specBytes, spec?, note?}`. It is sent while the lease is still held (release waits for the handoff). `spec` is the document itself when it is at most 64 KiB; over that, `spec` is left out and `note` is `spec too large` (size and hash still sent). There is no `url`/`specUrl`. The lease token is never in the PR text, the process journal or the logs. It is optional, non-blocking evidence (`evidence.review.lens`); a Canvas without the endpoint (404) or refusing it changes nothing about the pull request. A `pr.lens` process event (review, ok) shows it on the live process wall.
- **Nothing found, an unusable spec, or `AGENT_OFFICE_OPORA_PR_LENS=off`**: skipped silently, and the worker isn't asked to draw.

Code: `src/server/opora/pr-lens.ts`, called from `pull-request-handoff.ts` and `execution-prompt.ts`.

## The reviewer eval

Every revert and incident Canvas records becomes an eval case (`GET /api/oporahub/review-evals/export.jsonl`). The eval replays them through the review prompts to check a prompt change doesn't make the reviewers worse:

```bash
npm run opora:review-eval -- --project <id> [--workspace <id>] --repo <the project's checkout>
npm run opora:review-eval -- --project <id> --variant my-prompts.json   # baseline and variant, then KEEP or DROP
```

For each case it adds a fresh detached worktree at the case's `headSha` (from the checkout's `origin`), takes the diff from the merge base with `baseSha`, and runs the same pipeline as the review workers: `--finders` finder runs (each a fresh `claude -p` with no session), the same answer checks and fingerprints, then `--voters` voter runs over the grouped candidates, a candidate confirmed with `--required-votes`. The case's recorded findings are never shown to the models. An invalid answer counts as an empty one (no repair run, so the budget is exact).

**Scoring.** A case is *caught* when a confirmed finding touches a file the revert changed (`git diff revertSha^ revertSha`; *line-caught* when it's within 3 lines of a reverted hunk), or, for an incident, a file its reference or summary names. **Recall** is caught over scored cases; **noise** is confirmed findings that touch none of it. The score is `recall − noise-weight × noisy findings per case` (weight 0.1 by default). A variant is **kept only if its score goes up and its recall doesn't go down**; the CLI exits with 2 when it should be dropped. The report also says, per case, how many of the case's earlier findings a confirmed finding still lands on (`priorKept` of `priorTotal`).

| Option | Default | |
| --- | --- | --- |
| `--kind code\|security` | `code` | Which prompts are evaluated. |
| `--variant <file.json>` | none | `{"finder": "...", "voter": "..."}` (both kinds) or `{"code": {...}, "security": {...}}`: system prompts to try. |
| `--baseline-report <file>` | none | Compare the variant against an earlier report's baseline instead of re-running it. |
| `--max-cases`, `--max-runs` | 20, 60 | The budget: cases replayed, and model runs in all. A case starts only if the runs it could need (both sides) are left; the rest are reported as skipped. |
| `--cases <file.jsonl>` | Canvas's export | Read the cases from a file. |
| `--dry-run` | off | No model: every slot answers "no findings", to check the export, checkouts and revert diffs for free. |
| `--out <file>` | `.agent-office/opora-review-evals/report-<time>.json` | The JSON report. |

Nothing is written to Canvas. Code: `src/server/opora/review-eval.ts`, `review-eval-cli.ts`.

## Pull requests from the isolated broker

The [isolated executor](opora-isolated-execution.md) runs in a provider container on the pinned published commit, so its work isn't in any local worktree. Its prompt now asks the remote agent, if it changed files, to commit them and return `git format-patch --stdout <pinned>..HEAD` as `result.patch` (at most 60 000 characters, inside the 64 KB result). Once Canvas has confirmed the result, and while the lease still holds:

1. the floor's `origin` must be the run's repository; the office adds a throwaway worktree at the **pinned commit** (fetching it if needed);
2. it applies the patch with `git am --committer-date-is-author-date` under a fixed committer (a plain diff is wrapped as a one-commit mailbox dated at the result's time), so the same patch always makes the same head commit;
3. it hands that worktree to the same `PullRequestHandoff` as a card worker: branch `opora/<card>/<execution>`, the Opora trailers, the Canvas link with the execution's credentials, and the same per-head idempotency. The patch itself stays out of the PR body;
4. the self-checks, if configured, run in that tree afterwards, and the tree is removed.

No patch, a patch that doesn't apply to the pinned commit, a different `origin` or `AGENT_OFFICE_OPORA_AUTO_PR=off` opens nothing (with a log line); the Canvas result stands either way. `.agent-office/isolated-executions/pull-requests/` keeps the handoff's records. Code: `src/server/opora/isolated-pull-request.ts`, called from `isolated-service.ts`.

Tests for all four: `tests/opora-review-security-evals.test.ts`, with fakes for Canvas, git, gh, the checks and the model.
