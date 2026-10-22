# agent-office

- Ship every code change as a PR branched from freshly fetched `origin/main`, and end with the PR URL instead of stopping at a local commit or asking first.
- The main checkout is shared with other live sessions and board agents, so do branch work in a worktree and never stash, reset or commit anyone else's changes there.
- Verify with `npm run typecheck`, `npm test` and `npm run build`, plus a headless-browser screenshot for visual changes, rather than slow manual playthroughs.
- When a change affects how people run, deploy or use the office, update `README.md` and the matching `docs/*.md` page in the same PR.
- New features plug in through the registries as modules of their own (see `docs/code-layout.md`), never by adding their code to `main.ts`, `server.ts`, the state store, `protocol.ts` or another feature's files, and `tests/size.test.ts` must stay green.
- Every modal needs a top-right ✕, and closing it by ✕ or Esc must put the player straight back into mouse-look with no extra click.
- Follow `docs/cista-linie.md`: intent before code, small PRs from fresh main without chains, rebase not merge, merge via the queue, deploy = server+client, owner cleans up.
- When asked to merge PRs, merge only webdevcody's (anyone else's only when linked, after a security review), resolve conflicts so both sides survive, and squash-merge.
