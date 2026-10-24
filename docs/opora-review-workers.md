# Opora review workers

Back to the [README](../README.md). Part of the [Canvas execution](opora-execution.md) loop: run → pull request → review → merge gate.

Canvas (OporaHub phase 3a, `docs/oporahub-review-jobs.md` in Opora Canvas) queues an automated code review job for every new head commit of a pull request linked to an execution, and does all the bookkeeping itself: slots, rounds, risk, vote aggregation, de-duplication and the merge gate. The office supplies the models: **review workers** claim the job's slots, look for bugs (finders) or check what the finders proposed (voters), and post the outcome to the pull request.

## Turning it on

Off by default. It runs only when both sides are on: Canvas with `OPORA_REVIEW_JOBS=1` (or `enabled = true` in its `opora_review_jobs.toml`), and the office with:

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENT_OFFICE_OPORA_REVIEWS` | off | `on` (or `1`, `true`, `yes`) starts the review workers on every floor linked to an Opora project. Needs the `claude` CLI on the office's machine. |
| `AGENT_OFFICE_OPORA_REVIEW_PARALLEL` | `2` | Review slots running at once per floor (1–8). |
| `AGENT_OFFICE_OPORA_REVIEW_PER_HOUR` | `12` | Review slots started per floor in any rolling hour (1–200). |
| `AGENT_OFFICE_OPORA_REVIEW_TTL` | `600` | Seconds of slot lease asked of Canvas (30–3600); a heartbeat renews it every third. |
| `AGENT_OFFICE_OPORA_REVIEW_TIMEOUT_MIN` | `20` | Minutes one model run may take before it's killed and the slot released. |
| `AGENT_OFFICE_OPORA_REVIEW_MODEL` | Claude Code's default | `--model` for the review runs. |
| `AGENT_OFFICE_OPORA_REVIEW_IDLE_MAX` | `300` | Longest wait in seconds (20–3600) between claims while Canvas keeps answering that there's no slot (see below). |
| `AGENT_OFFICE_OPORA_REVIEW_POST` | on | `off` stops posting completed reviews to GitHub; the findings stay on Canvas. |

When Canvas answers 409 `review_jobs_disabled` (or 404, a Canvas without review jobs), the floor logs it once and asks again ten minutes later.

**Idle backoff.** A claim that finds no slot makes the floor wait before claiming again: 20 seconds after the first, then 40, 80, 160 and on up to `AGENT_OFFICE_OPORA_REVIEW_IDLE_MAX` (5 minutes by default), each shortened by up to a fifth at random so floors don't ask in step. An idle floor so claims about 16 times an hour instead of 180. It goes back to claiming on every poll as soon as it gets a slot, or when the review job listing it reads for posting shows a job in phase `find` or `vote`, so new work waits at most one poll once Canvas lists it.

## What a slot does

On each 20-second poll of the floor's Opora bridge (less often while idle, see above), while there's room under both limits, the office claims a slot (`POST /api/oporahub/review-jobs/claim`, as `X-Opora-Actor: agent; name=office-<floor>-review`) of the floor's linked project and workspace, and runs it:

1. **A read-only checkout.** It fetches the pull request (`refs/pull/<n>/head`, else the commit) from the floor's `origin`, which must be the job's repository, and adds a detached worktree at `headSha` under `.agent-office/opora-reviews/checkouts/`. The diff is `sinceSha..headSha` in a later round, else from the merge base with `baseSha`, else with `origin`'s default branch. The worktree is removed when the slot ends; nothing is committed or pushed from it.
2. **A fresh model context.** Every slot, and its one repair attempt, is a new `claude -p` process with `--no-session-persistence`, no `--resume`/`--continue`, none of the user's or project's settings, hooks, MCP servers or plugins, and only the `Read`, `Grep` and `Glob` tools in that checkout. The slot token never goes into a prompt. The diff, earlier findings and candidates go in as quoted data, never as instructions.
3. **Finder:** hunt for correctness and security bugs in the diff only, answering `{"findings":[{path, line, severity, bugClass, title, rationale}], "fixed":[{findingId, rationale}]}`. The office computes each finding's fingerprint itself, `rv:<bug class>:<sha256(path, normalized title, bug class)>`, drops any whose fingerprint Canvas already knows (`knownFindings`, in any status) and keeps only fix claims of open findings. **Voter:** verify every candidate against the code at `headSha` and confirm only a concrete, reproducible one, answering `{"votes":[{candidateId, verdict, rationale}]}` with exactly one vote per candidate.
4. **Checked in code.** The answer must be one JSON object (raw, or in one complete `json` fence, with no prose around it) within Canvas's bounds; the system prompt and the prompt's last line both say so, since a model in a tool-using session likes to add a preface or a summary. An invalid answer gets one repair run (fresh, given the rejected answer and what was wrong); a second invalid answer releases the slot for another worker.
5. **Heartbeat, release, submit.** A heartbeat every third of the lease keeps the slot; a lost lease (409) aborts the run without submitting. Any other failure releases the slot. The submission's `requestId` is derived from the job, slot and epoch, so a retried submit replays the same receipt instead of conflicting.

## Posting to GitHub

On the same poll, the office reads `GET /api/oporahub/review-jobs?project&workspace` and, for every job in phase `completed`, posts one pull request review through `gh api`: event `COMMENT` only (never `APPROVE` or `REQUEST_CHANGES`, never a merge), with the head commit as `commit_id`. Agent reviews never count as human approvals on Canvas's merge gate.

- **The body.** It starts with the marker `<!-- opora-review-job:<reviewJobId> -->` and lists the round's findings tagged `**[severity]** \`findingId\`` with their `path:line`. Several finders often report the same bug in their own words, and Canvas confirms each as its own finding; the body shows such a cluster once (same status and path, lines within 40 of each other or one without a line, titles sharing enough words), led by its worst-severity finding, with a line *Reported by N finders; also \`rf_…\` (\`path:line\`)*. This is display only: Canvas keeps every finding (`review-dedupe.ts`).
- **Inline comments.** Each open cluster's lead with a path and a line gets an inline comment if that line is in the pull request's diff (an added or context line of a hunk, read from `pulls/<n>/files`). GitHub refuses a review whose inline comments include any other line, so a finding outside the diff is named in the body only and the office logs `N finding(s) … point outside the pull request's diff`. If GitHub still refuses the comments, the review goes out with the body alone and the log says *GitHub refused the inline comments …*.
- **Exactly once, updated in place.** A job's review is found by its marker. One already submitted has its body updated in place (no call at all when the body is the same); with older duplicates, the oldest one is kept up to date. A new one is opened as a *pending* review, checked once more, then submitted. GitHub allows one pending review per account per pull request, so a second office posting the same Canvas on the same GitHub account (say a live office and an integration office on one floor) either is refused or sees the first one's pending review, and waits for the next poll, where it finds the submitted review. A pending review with the marker left for over two minutes (its poster died before submitting) is submitted by the next poster. In one office, posts to the same pull request run one at a time. Two offices on *different* GitHub accounts can't see each other's pending reviews, so run only one posting office per Canvas there (`AGENT_OFFICE_OPORA_REVIEW_POST=off` on the others).
- `.agent-office/opora-reviews/posted.json` remembers what was posted, so an unchanged job costs no GitHub call.

## Security jobs, evidence and the eval

Jobs of kind `security` get a security prompt and `security:` fingerprints, and a kind the office doesn't know is released; self-check evidence and the reviewer eval (`npm run opora:review-eval`) are in [security reviews, evidence, eval and isolated PRs](opora-review-evidence.md).

## Code

`src/server/opora/review-runner.ts` (the loop, limits and backoff, composed by `bridge.ts`), `review-config.ts` (settings, the hourly budget and `idleClaimDelay`), `review-client.ts` (the Canvas API), `review-slot.ts`, `review-checkout.ts`, `review-agent.ts`, `review-prompt.ts`, `review-output.ts` (parsing, validation, fingerprints) `review-github.ts` (posting), `review-dedupe.ts` (one cluster per bug in what's posted) and `review-diff-lines.ts` (the diff's commentable lines). Tests: `tests/opora-review-jobs.test.ts` and `tests/opora-review-posting.test.ts`, with fakes for Canvas, git, gh (a fake GitHub with its one-pending-review rule) and the model.
