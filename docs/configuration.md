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

A floor is linked to the Opora project whose folder is that floor's checkout (Opora's local or git project for the same folder). When no project's folder is the floor's, or you want another one, pick the project in the 🛰️ Opora window's **Linked to** list; *— by folder —* goes back to matching by folder. The choice is the floor's, for everyone on it, and it can't change while the office is on cards of the project it's linked to. If the chosen project is deleted on Opora, the floor falls back to the folder's (and the window says so). The office keeps the choice and what it took from Opora in the floor's `.agent-office/opora.json`, the lease tokens included.
