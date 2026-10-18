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

## Opora Canvas

The planning room links each floor to [Opora Canvas](features.md#opora-canvas), the app where the work is planned, through Opora's HTTP API, from the office's server. Two environment variables set it up, and neither is needed when Opora runs on its default address on the same machine:

| Variable | What it does |
| --- | --- |
| `AGENT_OFFICE_OPORA_URL` | Where Opora listens, from the office's machine. Default `http://127.0.0.1:8740`, `uv run opora`'s default. Opora only answers on loopback, so it has to run on the office's machine. |
| `AGENT_OFFICE_OPORA_DIR` | Opora's repository (the folder with `opora.toml`). With it set, an admin can start Opora from the 🛰️ Opora window (`uv run opora --no-open` there) when it isn't running. The office never starts a second one while one answers. |

A floor is linked to the Opora project whose folder is that floor's checkout (Opora's local or git project for the same folder). When no project's folder is the floor's, or you want another one, pick the project in the 🛰️ Opora window's **Linked to** list; *— by folder —* goes back to matching by folder. The choice is the floor's, for everyone on it, and it can't change while the office is on cards of the project it's linked to. If the chosen project is deleted on Opora, the floor falls back to the folder's (and the window says so). The floor reads the project's `main` workspace (else its first), and that's read-only for a git project on Opora, where the planning happens in work workspaces: pick the one to read and take cards from in the window's **Workspace** list (Opora's labels, ● on the one in use); *— default —* goes back to `main`. Linking another project resets it to the default, and if the picked workspace is deleted on Opora the floor reads the default one again (and the window says so). A card the office already took keeps the workspace it was claimed in until its worker goes home. The office keeps the choices and what it took from Opora in the floor's `.agent-office/opora.json` (`linkedTo` for the project, `workspace` for the workspace), the lease tokens included.

### Designers

Cards on Opora's design pipeline go to the designers' desks, and their brief has them read what the person sketched (drawings, storyboards, attachments) and build it. They work with what the worker's Claude Code has, and do without what it doesn't:

- **The opora-control-center skill**, for reading the card: `opora_read.py node-brief --raw`, `drawing --layer <card id>` (and `sb/<card id>/<moment id>` for a storyboard moment's sketch) and `drawing-file --id <fileId> --out <file>.png` for the images in them.
- **The chrome-devtools MCP**, to open the card's drawing (`?…&mode=drawing&layer=<card id>`) and storyboard (`?…&mode=storyboard&node=<card id>`) on Opora in a headless browser and screenshot them, and to screenshot their own work. Opora has to be on the same machine (it only answers on loopback).
- **The frontend-design and ui-theme-designer skills** (Claude Code plugins), for building the screens and their tokens and themes.
- **The claude-design MCP** (optional), to read a Claude Design artifact a card links to. Add it once for your user, then authenticate it in an interactive Claude Code session with `/mcp` (and run `/design-consent` if it refuses):

  ```bash
  claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp
  ```

  Until it's connected, designers work from the sketches alone.

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
