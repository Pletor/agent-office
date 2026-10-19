# Boss Office — Pro tebe

The board inside the Boss Office's north glass (up the stairs, facing into the room) is your inbox for decisions and answers. Aim at it and press **E**. The top-right **✕** or **Esc** closes it and returns to mouse-look without another click.

## What belongs to you

- **An explicit Opora question:** the original question, full parent path, next action, and **Otevřít v Opoře**. The link selects the exact task inside its parent layer, not the project root. Answer using the card's existing controls in Opora.
- **A completion proposal:** only after the pipeline is complete. Inspect evidence in Opora before confirming; the board never approves on your behalf and Opora remains the authority for all gates.
- **A worker waiting for input:** the current question/permission summary and **Otevřít terminál**, using existing terminal navigation. A finished/idle worker alone is not a human task.

**K dořešení systémem / agentem** is separate. Bridge/run errors and premature completion proposals are not requests for your approval. The board explains the next repair step but does not start repair workers, change leases, dismiss errors, reset proposals, or resume autopilot.

## Scope and freshness

This is a shared boss inbox, not per-account assignment. It covers **the current floor's linked Opora project and selected workspace**, plus workers on that floor. It ignores switchboard focus so requests elsewhere in that workspace are not hidden. It does not aggregate other floors or workspaces.

Link the floor and select its workspace in the existing Opora window. The board displays that scope and last check time, refreshes every 15 seconds while the browser is visible, and offers **Obnovit**. Questions disappear when authoritative Opora state no longer requests a human response; workers disappear when they no longer need input. Changing floor/project/workspace clears the old list and cancels outstanding reads.

Server reads are shared across browsers on the same floor and cached for up to 15 seconds (including manual refresh). They have a 20-second total deadline, at most four simultaneous proposal reads, and a 64-proposal limit; hitting a limit is reported as incomplete data, never an empty success.

If Opora cannot be reached, a response is incomplete, or a proposal's pipeline cannot be verified, the UI reports uncertainty instead of claiming there is nothing to do. Questions from sources still available remain visible. Error text never assigns a system error to a person.

## Implementation and verification

Client: `src/client/features/bossattention/`, installed through interaction and fixture registries. Authenticated read-only route: `GET /api/boss-attention?floor=<id>`. Its upstream is configured by the existing bridge; clients cannot supply arbitrary URLs. It reads work overview, hierarchy and necessary proposal briefs. No persistent task state or approval endpoint is introduced.

Run `npm run typecheck`, `npm test`, `npm run build`. Focused tests: `node --import tsx --import=#tests/css --test tests/boss-attention*.test.ts`. `tests/boss-attention.browser.mjs` checks the production office, physical board/E, screenshots, links, error/empty states, focus and ✕/Esc mouse-look restoration. It uses labeled fixture responses for states; run against a separate preview, never a shared live session.

This feature does not repair the independent Harness orchestrator identity/lifecycle issues. Those remain separate work.

## Screenshots

[Physical board](shots/boss-attention/boss-board.png), [desktop](shots/boss-attention/boss-dialog-desktop.png), [mobile](shots/boss-attention/boss-dialog-mobile.png), [empty](shots/boss-attention/boss-empty.png), [unavailable](shots/boss-attention/boss-error.png) use explicitly labeled UI fixtures. [Live Harness workspace](shots/boss-attention/boss-live-harness.png) shows actual read-only Opora data: H05 is a premature proposal for agents to finish, not a request for the boss to approve.
