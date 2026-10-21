# Process Observatory

The separate `/process-studio` page is an interactive Czech-language **simulation**, built with the office and protected by its existing session authentication. After signing in, navigate to `/process-studio`. With the Vite development server, open `/process-studio.html` instead. No additional dependency or server configuration is required.

It demonstrates how an Opora task, office workers, memory and GitHub could share an observable workflow. It does not connect to Canvas, OpenViking, GitHub or a running worker. Every event, test result, memory record, PR and merge displayed on the page is model data.

## What the scenario demonstrates

1. A card has a goal, scope, expected output and acceptance conditions. Recall brings earlier experiences into the plan.
2. A missing reconnect condition blocks handoff. Refinement creates a new revision, with explicit proof requirements.
3. Two workers perform parallel work in the modeled office. Their completion is distinct from passing checks.
4. A duplicate-event regression fails a check. The workflow grows a repair node and a new plan revision. Earlier checks and approvals become invalid.
5. New checks cover the repaired behavior and every added repository. Review and a sample PR become available only for the current revision.
6. The simulation stops at the human decision. **Schválit v ukázce** authorizes only the local scenario to continue; it does not merge a real PR.
7. A memory candidate is proposed from the evidenced result, then a separate event confirms persistence. A subsequent task recalls it. Reuse is not presented as measured improvement.

The precise acceptance conditions and evidence are available under **Plán** and **Detail**. The spider animation only interpolates positions from state; it never controls a transition or supplies evidence.

## Controls

- **Tok procesu / Vazby paměti** switches between the workflow and an illustrative context/evidence relationship view. The latter does not depict an LLM's internal neurons.
- **Pozastavit**, **Krok**, speed and restart control the deterministic scenario. Reduced-motion preference starts it paused and suppresses procedural motion.
- Select a node with a pointer or Enter/Space to inspect its status, revision and evidence.
- The history slider restores an earlier snapshot for viewing. It pauses playback and hides the approval action. Returning to the latest event does not automatically resume playback.
- **Exportovat stopu** downloads JSON with `schemaVersion`, `mode: "simulation"`, the run, configured repositories and observed events. The application does not import arbitrary event files.
- The information dialog closes with its top-right X or Escape and restores focus to its opener. This standalone page has no 3D player or mouse-look to restore.

## Adding a repository to the model

The **Moduly** pane opens by default. Supply an exact `https://github.com/owner/repository` URL and choose a role: context source, implementation module or checking service. Up to four additional repositories can participate.

Adding one starts a new model run and clears that run's previous history. Export first if the previous trace is needed. The extension receives a visible graph node, an inspect/verify step, a plan entry and a mandatory inclusion in the subsequent checks. It is kept only in page memory; reloading clears it. Duplicate identities and malformed URLs are rejected. URL values are rendered as text, not HTML, and are never fetched or cloned.

This describes how an integration contract could appear. It does not infer an unfamiliar repository's architecture or execute any of its functions. A functioning integration still needs an authenticated adapter and independently verified input/output semantics.

## Implementation and future integration boundary

- `src/client/process-studio/model.ts`: pure state reducer, event identity/order, plan revisions and evidence gates.
- `scenario.ts`: the explicitly simulated producer; repository extensions insert their steps here.
- `graph.ts` / `motion.ts`: graph projection and separate visual interpolation.
- `panels.ts` / `index.ts`: inspection, playback, history, extension form and trace export.
- The Vite input registry and `http/routes/index.ts` register this entry independently of the 3D office and its state store.

Future live adapters need to correlate `run`, task, worker, repository, plan revision, operation/attempt and evidence identity. They must translate actual service observations into domain events, authenticate the source, handle reconnect snapshots and persist events. The demo reducer is **not** an authorization boundary or a production ingestion API: it consumes a local typed scenario, not untrusted service messages.

In particular, OpenViking session submission is not confirmation that asynchronous memory processing finished. Recall only proves that context was supplied, not that it caused a better answer. A claim of improvement requires a comparable evaluation, outside this demonstration.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. `tests/process-studio.test.ts` checks the complete scenario and failure paths: missing plan conditions, invalid/stale evidence, blocked merge, duplicate/out-of-order observations, missing repository coverage and memory lifecycle ordering. Use a headless browser to exercise the actual page, including the repository form, replay and human gate, and capture both graph views.
