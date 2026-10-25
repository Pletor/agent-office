# Configuration

Back to the [README](../README.md).

## Where the office keeps things

The office keeps its data in `~/agent-office` (`--home` or `AGENT_OFFICE_HOME` to move it) and clones projects next to it, as `~/agent-office/<owner>/<repo>`. To clone them somewhere else, like `~/Workspace`, an admin picks the **Workspace folder** in ⚙️ Settings → **🏢 Building** (or start with `--projects` or `AGENT_OFFICE_PROJECTS`). Floors you already have stay where they are, and a checkout of the same repository that's already in the new folder is used as it is. The building's map is in `~/agent-office/.agent-office/map.json`, and maps of your own go in `~/agent-office/.agent-office/maps/` (see [Maps](maps.md)). The list of floors is `~/agent-office/.agent-office/floors.json`, and each account's own Claude and GitHub sign-ins are in `~/agent-office/.agent-office/homes/<account>/` (revoking the account deletes them). Each floor keeps its workers, queue, pictures and worktrees in its own checkout's `.agent-office/`.

Already have a checkout? Pick its repository anyway: a checkout of it that's already where the workspace folder would clone it is used as it is. You can still start the office in a project, `agent-office ~/code/my-project`: that project becomes a floor, and the office keeps its data in `~/code/my-project/.agent-office` as it did before there were floors. An office that already ran in a project carries on in it when you start `agent-office` there again. An admin can take that project off the building in the elevator like any other floor.

## Command line

```
agent-office [dir] [options]

      --home <dir>        Where the office keeps its data without a [dir] (default ~/agent-office)
      --projects <dir>    Where new floors are cloned, as <dir>/<owner>/<repo> (default ~/agent-office;
                          also settable from ⚙️ Settings)
  -p, --port <n>          Port (default 4600, env PORT)
  -H, --host <addr>       Bind address (default 127.0.0.1; 0.0.0.0 lets your network in)
      --password <pw>     Office password (env AGENT_OFFICE_PASSWORD)
      --no-open           Don't open the office in your browser when it starts
      --agent <cmd>       Default agent command (default "claude")
      --agent-args <str>  Extra args for the configured agent, e.g. "--model opus"
      --dsh-profile <n>   DeepSeek Harness profile over ACP (default "acp")
      --tls-cert <file>   Serve HTTPS with this cert…
      --tls-key <file>    …and key
      --self-signed       Serve HTTPS with a generated self-signed cert
      --trust-proxy       Trust X-Forwarded-* (behind Caddy/nginx)
      --turn <url>        Add a TURN server for voice, e.g. turn:user:pass@host:3478
                          (env AGENT_OFFICE_TURN, several separated by spaces)
      --budget <usd>      Daily tracked Claude Code budget (OpenCode/Codex/Grok/Muse/DSH excluded)
      --budget-pause      ...and nobody can hire a new worker until the next day
      --max-workers <n>   Run at most n workers at once, across every floor (env AGENT_OFFICE_MAX_WORKERS)
      --webhook <url>     Post to this Slack / Discord webhook when a worker needs input or finishes
      --city <name>       Put the office in a real city: its sun and live weather (open-meteo.com)
      --weather <kind>    Pin the weather: clear, cloudy, rain, storm, snow or fog
      --real-time-sky     Start the sky on the real clock, not a day an hour (env AGENT_OFFICE_SKY_CLOCK=real; ⚙️ Settings can switch it)

agent-office setup [--projects <dir>] [--project <owner/repo>]... [--home <dir>]

  The first-start walkthrough again: the workspace folder, GitHub sign-in and
  repositories to clone as floors. With --projects / --project it asks nothing.
  Run it while the office is stopped.

agent-office prune [dir] [-n|--dry-run] [-f|--force]

  Removes leftover worker worktrees under .agent-office/worktrees/ and their
  office/* branches, in one floor's checkout (dir). Anything with uncommitted changes or unpushed commits is
  kept unless --force is given. A worker across several projects has worktrees of them in its
  own floor's workspace: prune each project to clear those out.

agent-office accounts [list | invite [name] [--admin] | revoke <name> | role <name> admin|member | password on|off] [-d <dir>]

  Invite, list and revoke people's own accounts, and switch the shared password
  off or on. Works while the office runs.

agent-office tunnel [office@address | url] [--port <n>] [--office-port <n>] [--name <name>] [--password <pw>] [--no-open] [--insecure] [-- <ssh options>]

  On your own computer, for an office that runs somewhere else: every web server
  a worker starts there opens on the same port here, by itself, and closes when
  the worker stops it. Given an SSH address it opens the tunnel to the office too.
  See docs/tunnel.md.
```

## Worktree setup

A fresh worktree has the project's files but none of its dependencies: no `node_modules`, no `.venv`. To have the office install them before a worker starts, put `.agent-office/worktree-setup.json` in the floor's checkout:

```json
{ "command": "npm ci && uv sync --frozen", "timeoutMin": 15 }
```

`command` runs in the platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere) in each worktree the office cuts for a worker (in a workspace across repositories, in the floor's own project's worktree), before the worker starts; `timeoutMin` bounds it (default 15, at most 120). The office's log gets one line under `[worktree-setup]` when it passes, and the last 15 lines of its output (redacted) only when it fails. The worker starts either way, and the last line of its first prompt says how it went: that the dependencies are installed, and with which command, or that the setup failed, with its exit code and last line of output, and that the worker should fix the environment before running checks. Before the office runs [self-checks](opora-review-evidence.md#self-check-evidence) in a worktree where this setup hasn't passed yet (a PR upkeep's throwaway worktree, a worktree from before the file existed), it runs the setup there first. Whether it passed is remembered in the worktree's own git directory (`agent-office-setup.json`), never among its files. The file is read for each new worktree, so an edit applies from the next hire. Without it, or with one that isn't valid JSON with a non-empty `command`, there's no setup (the log says so once) and worktrees start as they always have. Meetings' shared worktrees and workers in the main checkout get no setup.

## Opora Canvas

**Execution compatibility:** Taking cards now requires Canvas OporaHub execution endpoints and an accepted plan matching the relevant live context. See [execution authority and restart recovery](opora-execution.md). Old lease-only Canvas versions cannot run new card workers.

The planning room links each floor to [Opora Canvas](features.md#opora-canvas), the app where the work is planned, through Opora's HTTP API, from the office's server. Two environment variables set it up, and neither is needed when Opora runs on its default address on the same machine:

| Variable | What it does |
| --- | --- |
| `AGENT_OFFICE_OPORA_URL` | Where Opora listens, from the office's machine. Default `http://127.0.0.1:8740`, `uv run opora`'s default. Opora only answers on loopback, so it has to run on the office's machine. |
| `AGENT_OFFICE_PROCESS_PUSH` | `0` stops the office pushing its live process events to Opora (`POST /api/oporahub/process-events`, see [the process wall](process-wall.md#event-journal)). On by default, for floors linked to an Opora project. `0` also stops following Opora's event stream. |
| `AGENT_OFFICE_OPORA_STREAM` | `0` stops each floor following Opora's event outbox live (`GET /api/oporahub/events/stream`, see [Opora's event stream](process-wall.md#oporas-event-stream)); Opora's side then reaches the journal only through the bridge's polls. On by default, one connection per floor linked to an Opora project and workspace. |
| `AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S` | How many seconds each execution request to Opora may take (reading a card's context, the claim, the assignment read, the release, reading a stored result, and each attempt of the worker's result submit) before the Take fails with "Opora didn't answer within N s". Default `20`, 1 to 120. See [when a Take fails](opora-execution.md#when-a-take-fails). |
| `AGENT_OFFICE_OPORA_HEARTBEAT_TIMEOUT_S` | The same for each lease heartbeat, default `15`, 1 to 120; never past what is left of the execution's deadline. A heartbeat that times out is retried every 2 s, and the deadline doesn't move for it. |
| `AGENT_OFFICE_OPORA_DIR` | Opora's repository (the folder with `opora.toml`). With it set, an admin can start Opora from the 🛰️ Opora window (`uv run opora --no-open` there) when it isn't running. The office never starts a second one while one answers. |
| `AGENT_OFFICE_OPORA_AUTO_PR` | `off` (or `0`, `false`, `no`) stops the office pushing a reported Opora execution's commits and opening its pull request. Anything else (the default) leaves it on wherever the floor's `origin` is on GitHub and `gh` is signed in; otherwise each execution is skipped with a toast. See [pull request handoff](opora-execution.md#pull-request-handoff). |
| `AGENT_OFFICE_OPORA_REVIEWS` | `on` starts review workers that run Canvas's automated code review jobs and post completed rounds to the pull request (off by default; Canvas must have review jobs on too). Limits and the rest: `AGENT_OFFICE_OPORA_REVIEW_PARALLEL`, `_PER_HOUR`, `_TTL`, `_TIMEOUT_MIN`, `_MODEL`, `_POST`. See [review workers](opora-review-workers.md). |
| `AGENT_OFFICE_OPORA_UPKEEP`, `AGENT_OFFICE_OPORA_GUARD` | Both off by default. `on` keeps the office's open Opora pull requests rebased on their base (a headless Claude resolving textual conflicts, `AGENT_OFFICE_OPORA_CHECK_COMMAND` gating every push), and watches the base branch's CI to bisect a red `main` and open a revert PR for the first bad Opora merge. Neither ever merges. Budgets and the other settings are in [PR upkeep and the post-merge guard](opora-pr-upkeep.md). |
| `AGENT_OFFICE_OPORA_PR_LENS` | `on` by default. `off` (or `0`, `false`, `no`) stops asking Opora workers for a PR Lens spec and stops the handoff summarising it in the pull request as text and sending it to Canvas as optional review evidence. See [PR Lens diagrams](opora-review-evidence.md#pr-lens-diagrams). |
| `AGENT_OFFICE_PR_LENS_CLI` | The PR Lens executable workers are told to run (`validate`, `render`). Unset: `node_modules/.bin/pr-lens` under `AGENT_OFFICE_PR_LENS_HOME` when that is set and exists, else `npx -y -p @coldtea/pr-lens-cli@0.13.2 -p @coldtea/pr-lens-renderer@0.3.2 pr-lens`. See [PR Lens](opora-review-evidence.md#pr-lens-diagrams). |
| `AGENT_OFFICE_PR_LENS_HOME` | A directory with the pinned PR Lens install (`node_modules/.bin/pr-lens`), e.g. Opora's `tools/pr-lens`. Used when `AGENT_OFFICE_PR_LENS_CLI` is unset. |
| `AGENT_OFFICE_OPORA_SELF_CHECKS` | Off by default. The checks the office runs on each PR head it hands off or PR upkeep pushes, posted to Canvas as self-check evidence: a JSON object (`{"tests":"npm test","build":"npm run build"}`) or `name=command` lines; `AGENT_OFFICE_OPORA_SELF_CHECK_TIMEOUT_MIN` bounds each. A floor's `.agent-office/opora-checks.json` (`{"selfChecks":{…},"checkCommand":"…"}`) overrides this and `AGENT_OFFICE_OPORA_CHECK_COMMAND` for that floor's project ([a floor's own checks](opora-review-evidence.md#a-floors-own-checks)). See [self-check evidence](opora-review-evidence.md#self-check-evidence). |

A floor is linked to the Opora project whose folder is that floor's checkout (Opora's local or git project for the same folder). When no project's folder is the floor's, or you want another one, pick the project in the 🛰️ Opora window's **Linked to** list; *— by folder —* goes back to matching by folder. The choice is the floor's, for everyone on it, and it can't change while the office is on cards of the project it's linked to. If the chosen project is deleted on Opora, the floor falls back to the folder's (and the window says so). The floor reads the project's `main` workspace (else its first), and that's read-only for a git project on Opora, where the planning happens in work workspaces: pick the one to read and take cards from in the window's **Workspace** list (Opora's labels, ● on the one in use); *— default —* goes back to `main`. Linking another project resets it to the default, and if the picked workspace is deleted on Opora the floor reads the default one again (and the window says so). A card the office already took keeps the workspace it was claimed in until its worker goes home. The office keeps the choices and what it took from Opora in the floor's `.agent-office/opora.json` (`linkedTo` for the project, `workspace` for the workspace), the lease tokens included.

### Designers

A card on Opora's design pipeline goes to the designers' desks, and its worker's execution prompt gets a design addendum, the **Opora design card** prompt (⚙️ Settings → **📝 Edit the prompts…**; empty sends none). Before it claims the card, the office reads (GET only, every failure counting as nothing found) the card's drawing and storyboard (`src/server/opora/sketches.ts`), its node on the canvas (inspiration images on its blocks, attachments, a linked Claude Design artifact), its design mode and the design system, and the addendum says what it found, with read-only links: the sketch as SVG (`/api/layout-preview?project=…&workspace=…&layer=<card id>`), its scene (`/api/drawing`) and the storyboard (`/api/storyboard`). The worker is told to read and look at them, build the screens and the motion, and deliver at most 8 screenshots of its last commit (light and dark × mobile 390 px and desktop 1440 px, plus storyboard moments) in `.agent-office/opora-previews/<project>/<card>/<head SHA>/`, outside the repository, with a `preview.json` in the shape of Opora's `POST /api/oporahub/review-jobs/preview` (`headSha`, `designMdSha256` or `null`, `proposedDesignMd` in explore mode only, `screenshots: [{file, label, viewport, stage?}]`, PNGs of at most 2 MiB), listed in its result's `artifacts`. The worker never calls that endpoint (it holds no token): the office uploads them, see [design previews](opora-review-evidence.md#design-previews). Developer cards get no addendum.

#### DESIGN.md and design-card modes

Each project keeps its design system (fonts, colours, brand, spacing, components) in a `DESIGN.md` at the root of its repository. The office reads it from Opora (`GET /api/oporahub/design-system?project=`) when Opora has one (`available: false` or a 404 counts as none), and otherwise from the floor's checkout as committed at `HEAD` (never uncommitted edits), up to 64 kB, saying when it was cut. The prompt cites it by revision and SHA-256, and the worker puts that SHA-256 in `preview.json` as `designMdSha256`. Up to 8 kB it goes into the addendum whole; a longer one by pointer (`git show HEAD:DESIGN.md`) with its section headings. What the worker is told depends on the card's design mode, which a person sets on Opora (*Podle brandu* / *Nový směr*). The office reads it from `GET /api/oporahub/review-preview` (`design.mode`). If Opora doesn't have that endpoint (404) or won't say (428), it falls back to the node's own `design.mode`, then to `brand`:

| Mode | The addendum says |
| --- | --- |
| `brand` (the default, also when Opora doesn't set one) | Follow `DESIGN.md` exactly: its fonts, colours, spacing and components, no new tokens; the screenshots are judged against it. A project without a `DESIGN.md`: build in the existing UI's style and write that style down as a proposed `DESIGN.md` at `design/proposals/<card id>/DESIGN.md`. |
| `explore` (a new brand direction) | Don't use the existing `DESIGN.md` or brand tokens (it isn't read at all): propose a fresh direction, committed as `design/proposals/<card id>/DESIGN.md` next to the screenshots. The root `DESIGN.md` is never overwritten; a person decides whether the proposal becomes the brand. |

What designers use, when the worker's Claude Code has it:

- **The opora-control-center skill**, for reading the card: `opora_read.py node-brief --raw`, `drawing --layer <card id>` (and `sb/<card id>/<moment id>` for a storyboard moment's sketch) and `drawing-file --id <fileId> --out <file>.png` for the images in them.
- **The chrome-devtools MCP** (or Playwright with the system Chrome), to open the card's drawing (`?…&mode=drawing&layer=<card id>`) and storyboard (`?…&mode=storyboard&node=<card id>`) on Opora in a headless browser, and to screenshot their own work. Opora has to be on the same machine (it only answers on loopback).
- **The frontend-design and ui-theme-designer skills** (Claude Code plugins), for building the screens and their tokens and themes.

### Opora full screen inside the office

**O** at the boss's chair (and **⛶ Open Opora full screen** in the 🛰️ Opora window) opens Opora inside the office, in a frame over the whole screen. Opora refuses to be framed until you list the office's address on Opora's side, in its `opora.local.toml`:

```toml
[app]
embed_origins = ["http://localhost:4600"]
```

Use the address the office's page has in your browser (the 🛰️ Opora window shows the exact line to add), and restart Opora. The office reads Opora's framing headers (`X-Frame-Options`, CSP `frame-ancestors`) each time it polls it; until they let the office in, **O** opens Opora in a tab of its own instead, as before. Esc closes the full-screen view from inside Opora too: Opora tells the page it's framed in, and the office only listens to Opora's own frame.

Opora's sign-in cookie is `SameSite=Strict`, so the browser has to reach Opora by the same name as the office: with the office on `localhost`, Opora as `localhost` too, and on `127.0.0.1`, as `127.0.0.1`. The office does that itself in the browser, whichever of the two `AGENT_OFFICE_OPORA_URL` names.

### Reverse engineering with REA

[REA (Reverse Engineer Anything)](https://github.com/morluto/rea) is an MCP server that lets an agent take apart an app, a website, an Electron or JavaScript bundle, a binary or an APK, and cite the evidence for what it finds. The office can hand it to its workers, so that a card or a plan that points at a reference app is first dissected and then laid out precisely on the Opora canvas: layers → areas, sectors, nodes/cards. It's **off by default**. An admin turns it on in ⚙️ Settings → **🤖 Workers** → **Reverse engineering (REA)**, for everyone in the building (kept in `.agent-office/rea.json`):

| Setting | Who gets REA |
| --- | --- |
| **Off** (default) | Nobody. |
| **🧭 Opora workers** (`opora`) | The workers the office seats for an Opora card (the developers' and the designers' desks) and the planner when it plans onto the Opora canvas. A plain worker, a board agent, the planner writing a plan file and the router don't. |
| **🤖 Every worker** (`all`) | Every worker the office starts. |

| Variable | What it does |
| --- | --- |
| `AGENT_OFFICE_REA` | `off`, `opora` or `all`: overrides ⚙️ Settings, which then shows the setting but can't change it. Anything else is ignored. |
| `AGENT_OFFICE_REA_PACKAGE` | The package the workers run, pinned to `rea-agents@6.7.0` by default. Set it to another exact version of the same package (`rea-agents@6.8.0`) to upgrade; a tag (`@latest`), a range (`^6`) or any other package name is ignored, and the pin is used. |

The office doesn't install REA, run it, or add it to anyone's own MCP config (never run `rea-agents setup` for the office: it edits your global `~/.claude.json`). It only puts REA, as `npx -y rea-agents@6.7.0 mcp` (`cmd /c npx …` on Windows), next to the office's own `agent-office` MCP server in the config of the workers the setting covers: Claude Code gets a second `--mcp-config` file, `.agent-office/rea-mcp.json`, so the shared `agent-office-mcp.json` stays the same for everyone; Codex gets `-c mcp_servers.rea.*` (with a 120 s start-up wait, for `npx`'s first download); OpenCode gets it in `OPENCODE_CONFIG_CONTENT`'s `mcp`. Other providers don't take MCP config from the office and don't get it. A change applies from each worker's next start. REA's tools aren't pre-allowed: Claude Code asks before each one, as it does for any tool it hasn't been allowed.

A worker REA is on for (an Opora card's, or the Opora planner) is also told how to use it, by the **Opora · reverse engineering (REA)** prompt after its brief: analyze the reference locally, cite the evidence, map it onto the canvas, only analyze software the user owns or may analyze, and never execute an untrusted target unless the card asks for runtime capture. Rewrite it or empty it in **📝 Edit the prompts…** like the others.

**Security.** REA runs local analysis tools as the worker's user, with that user's permissions, on whatever the worker points it at: treat it like any tool that executes code on the office's machine. The version is pinned so that a new release (or a compromised one) never runs without someone choosing it; check the package name when you move the pin, since lookalike names (`rea-agent`, `reaagents`…) aren't REA. Reverse-engineering software can be restricted by its licence or by law: only analyze what you own or have permission to analyze.

## The status wall

The 🚦 status wall over the gong (*Stav*) holds two repositories to their remote main, and checks what runs. Its words are Czech, the language of the people it was made for; the rest of the office stays English.

- **Kancelář** is the office's own install, the folder the server runs from. Its remote main is `AGENT_OFFICE_STATUS_REMOTE` when that's set (`fork/main`, say), else `fork/main` when the checkout has a remote called `fork` (a fork you push to, next to a read-only upstream `origin`), else what the local `main` tracks, else `origin/main`.
- **Opora** is Opora Canvas's repository, held to its `origin/main`: `AGENT_OFFICE_OPORA_DIR` when it's set, else the folder `Opora-control-center-canvas` next to the office's install, when either has `opora.toml`. The live Opora is the one at `AGENT_OFFICE_OPORA_URL` (default `http://127.0.0.1:8740`).

**Green** takes all of these: the office runs the remote main's commit (its `HEAD` as it started), `dist` was built from that commit with no uncommitted changes (the build stamps it in `dist/build-info.json`; under `npm run dev` there's no `dist` to match), the local `main` is neither ahead of nor behind the remote main, every branch, local or on that remote, with commits main doesn't have is merged (its pull request merged, which a squash merge needs since it leaves no ancestry, or its changes already in main: `git merge-tree` of it into main changes nothing), an open pull request that's a draft counts as work parked on purpose (*PR #n je odložený (draft)*, and the all-in-main line counts them: *odloženo: n draft PR*), no worktree of the repository has uncommitted changes to tracked files, and neither does the main checkout. Untracked files don't count. For Opora: it answers `GET /api/health`, its `GET /api/build-identity` says it started from the remote main's commit, and its `dist/index.html` is newer than the last change to `frontend/` in main.

**Amber** is work in progress, or a version a restart catches up: an open pull request that isn't a draft (*mergni PR #n*), a branch or a worktree with changes that belongs to a seated worker (by its worktree's folder or its branch), the local `main` behind the remote one (*git pull*), the office or Opora running an older commit of main (*potřeba restart*: just *restartuj kancelář* once the install is on main and built, else pull, build and restart), a new build on disk since the office started, or a version it can't tell: Opora without `/api/build-identity` is *verze neověřena*, unless the process on its port started after the checkout's `HEAD` commit, `HEAD` is the remote main and the frontend was built after its last change.

**Red** is work that isn't in main and nobody is on, or a build that doesn't match: the local `main` ahead of the remote (*pushni main*), a branch ahead of main with no pull request (*otevři PR*) or a closed one, uncommitted changes in a worktree with no worker or in the main checkout, a running commit that isn't in main, `dist` built from another commit or with uncommitted changes, and Opora not answering.

The checks run on the office's server, with `git` and `gh` started with fixed arguments and no shell: the cheap local ones every 30 seconds, `git fetch --prune` of each remote and `gh pr list --state all` every 5 minutes, and both as soon as someone opens the wall's window (at most one fetch a minute). Each result goes to everyone signed in. They only read, apart from the fetch (which updates the remote-tracking branches) and `git merge-tree`, which writes the merged tree it tries into the repository's object store. Nothing reads a process's command line: without `/api/build-identity`, only the start time of the process listening on Opora's port is looked up (`netstat` and `Get-Process` on Windows, `lsof` and `ps` elsewhere).

| Variable | What it does |
| --- | --- |
| `AGENT_OFFICE_STATUS_REMOTE` | The office's remote main, as `remote/branch` (`fork/main`). |
| `AGENT_OFFICE_STATUS_FETCH` | `off` (or `0`, `false`, `no`): never fetch, only compare with the remote-tracking branches as they are. |
| `AGENT_OFFICE_OPORA_DIR`, `AGENT_OFFICE_OPORA_URL` | Opora's repository and address, as for [Opora Canvas](#opora-canvas). |
