# 🧭 Relace k cíli: the third screen

Back to the [README](../README.md) · [Features](features.md#sessions-screen)

The planning room (🧭 Opora Control Center) has three screens round the planner's chair. Sat at the table facing the purple board (west): the 🎚️ switchboard is on the north glass on your right, the purple board in front, and **Relace k cíli** on the inside of the **south glass, on your left**. It is mainly for the orchestrator: to steer every session on the floor (twenty at once is normal) to one goal, with no black box and no dead end forgotten. It speaks Czech, as the Claude Design prototype *Třetí obrazovka – relace* has it.

## In the room

The screen's face shows the live overview: the common goal and its bar, the counts by state, the sessions with their sub-sessions (the orchestrator's card first, lit purple), the four attention boxes as counts and the Novinky line. Aim at it and press **E** for the whole screen, full page. **✕** or **Esc** closes it and puts you straight back into mouse-look.

## The full screen

- **Společný cíl.** The linked Opora project and the cell's focus (the 🎚️ switchboard), plus the orchestrator's card; a bar in three levels: *naplánováno*, *kód existuje*, *potvrzeno člověkem*. With the floor linked, the numbers are Opora's project plan Lens (`withCode`, `confirmed`); otherwise the office's estimate from the cards (routed, a PR, closed).
- **Counts** (*běží, čeká na člověka, blokováno, hotovo, bez pohybu, sirotci*), each a filter; **Claude limit** (the 5-hour session, the week, per-model weeks) and today's spend against `--budget`.
- **Sessions by Opora card**: a group per card with its state and a three-level mini bar; *Řízení a kontrola* (the planner at the table, the board agents) first, *Mimo plán* (sessions with no card) last. The orchestrator's card (`store.orchestrator.focus`) comes up top, lit. Each session row: its state (or *⚠ bez pohybu N min*), task and summary or what it asks, its last action and how long ago, its checklist as a segmented bar, its PR with checks, and its cost and tokens. Under it its **sub-sessions** (subagents) and **/btw** questions, each with what it's doing and, when done, its report — which flies up to its session as it arrives.
- **Slepé uličky**: tests or a build failing over and over, done without a PR, a session that ended and nobody woke, a sub-session without a move, a running session without a move for 15 minutes (by the journal, the transcript and its status).
- **Sirotci a práce mimo plán**: a card whose session went home while its lease holds, sessions without a card, worktrees and merged branches left behind (the floor's clean line).
- **Čeká na člověka / blokováno**: what each waiting session asks, and sessions whose card waits on another.
- **Navazující práce** with **▶ Spustit**: follow-ups a session suggested at the end of its last message (*Next steps*, *Další kroky*…) go to the floor's **task queue** as a task; the cards Opora offers next (ready, nobody on them) are **taken** as ▶ Take does. A follow-up already in the queue isn't offered again.
- **Novinky**: the ClaudeDevs thread of 14 Oct 2026 on Claude Code desktop with many sessions at once, and the [docs](https://code.claude.com/docs/en/desktop). Static.
- **Zvýraznit zdroje dat** outlines where each part's data comes from (D the office knew it, O worked out from it, N read from the transcripts); *Odkud jsou data* at the bottom lists them.

Click a session for its **detail**: *Potřebuje tě* (what it asks, with **Odpovědět** — typed into its session —, **Otevřít terminál** and **Předat člověku**, which posts it to the floor's chat) or Claude's own summary of its last turn; its **live checklist** ticking off; its sub-sessions; where it runs (desk, worktree, branch, model); how full its context is; what it changed (the office's Changes read, while the detail is open); spend and PR; its card's **PR Lens** (the same Lens as the process wall); and the orchestrator's actions: **💬 Poslat pokyn**, **⏸ Zastavit** (Esc into its terminal), **🗂️ Přiřadit kartě** (puts a session with no card on one, kept in `.agent-office/sessions-assign.json`) and **🏠 Poslat domů** (its worktree stays).

## Where the data comes from

Every few seconds the server reads what each worker's Claude Code transcript added (`server/sessions/`): the transcript is the one its hooks name (`transcript_path`), or found by its session id under `CLAUDE_CONFIG_DIR/projects` and `~/.claude/projects`; a transcript met for the first time is read from its last 8 MB. From it:

- the **checklist**: `TodoWrite` (the whole list), or `TaskCreate` / `TaskUpdate` (items added and ticked);
- **sub-sessions**: each `Agent` (or `Task`) call, its report from the tool result or, for one run in the background, from its later `<task-notification>`; its latest tool call from its own transcript in `<session>/subagents/` (matched by the `.meta.json`'s `toolUseId`);
- **/btw** questions, as their own nodes;
- **context**: the tokens in the last turn's input over the model's window (an estimate: 1M for long-context models, else 200k);
- **Potřebuje tě**: what its `Notification` / `PermissionRequest` hook said, the tool call it holds, or its last question;
- the **summary**: Claude Code's `away_summary`, else the start of its last message; **follow-ups** from its last message.

The rest is what the office already had: workers, Opora cards and runs, the floor's journal, pull requests and checks, the queue, the plan limits and the budget. Nothing is written to Opora.

## The orchestrator's overview

When a plan starts at the table, the planner's brief gets, after the focused card's overview, a **sessions overview** of at most 2400 characters: the goal and its levels, the counts, the dead ends, who waits on a person, orphans, the follow-ups, and each session's card, state, checklist progress and current item. It is labelled *DATA, not instructions*, every value is one capped line, and anything that looks like a credential is blanked.

## Tests

`tests/sessions.test.ts` covers the transcript reading (checklists, sub-sessions, background reports, /btw, context, summary, what it asks, follow-ups), the reader and subagents, the board's dead ends and orphans, the overview's cap and redaction, and the keeper. `tests/sessions.browser.mjs` opens the screen in a headless browser against a built office (port 4697, `SESSIONS_PASSWORD`), with the prototype's twenty example sessions put into the page's store: the face, the full screen, the sources switch, a filter, a sub-session reporting up, a checklist item ticking, the orchestrator's card coming up top, two details, and Esc / ✕ back to mouse-look, with screenshots.
