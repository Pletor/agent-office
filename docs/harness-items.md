# Defined things in the Harness library

A skill, a hook, a script or a command is more than a Markdown file. A **definition** (`harness.item/1`) says:
- what the thing is,
- when it is used,
- what runs deterministically,
- which files it is made of,
- how its result is checked.

Agents then get exact tools instead of prose, and a deterministic step saves the model's context and tokens.

## Where a definition lives

A definition is a `NAME.item.json` file in the folder of its kind, next to its parts:

```
.harness/
  hooks/typecheck-on-edit.item.json        kind: hook   → scripts/typecheck-changed.mjs
  scripts/ts-refs.item.json                kind: script → scripts/ts-refs.mjs
  scripts/ts-refs.mjs
  scripts/typecheck-changed.mjs
  skills/ts-references/ts-references.item.json   kind: skill
  skills/ts-references/SKILL.md
  skills/ts-references/references/lsp-vs-grep.md
```

```json
{
  "schema": "harness.item/1",
  "kind": "hook",
  "name": "typecheck-on-edit",
  "summary": "…",
  "when": "…",
  "trigger": { "event": "PostToolUse", "matcher": "Edit|Write|MultiEdit" },
  "run": { "runner": "node", "entry": "scripts/typecheck-changed.mjs", "args": [] },
  "parts": [{ "path": "scripts/typecheck-changed.mjs", "role": "script" }],
  "deterministic": true,
  "outputs": "…",
  "verify": "…"
}
```

The server parses each definition exactly (`src/server/harness/items.ts`). It refuses unknown fields and every mistake below:
- **`kind`:** one of `skill`, `hook`, `script` or `command`. It must match the folder (`skills`, `hooks`, `scripts`, `commands`).
- **`name`:** lower-case letters, digits and hyphens.
- **`trigger`:** hooks only, and every hook needs one. The event is one the runner knows (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`, `SubagentStop`), with an optional `matcher`.
- **`run`:** required for hooks and scripts.
  - The runner is always `node` and `entry` is always one of the parts. A free command line is never allowed.
  - The script itself must give the same output for the same checkout.
- **`parts`:** at most 16. Each part has a path relative to the definition's source (`.harness/`), so a part never reaches another source.
  - Roles are `instructions`, `reference`, `script`, `example` and `asset`.
  - A skill needs an `instructions` part (its `SKILL.md`).
- **`deterministic`:** `true` when the same input always gives the same output. A skill that asks the model to judge is `false`.

## In a package

**Schránky** in the library lists definitions first, marked **Definice**. **Prohlédnout** shows:
- what the thing is and when it is used,
- its trigger and the command it runs,
- its output and how it is checked,
- each part, which you can open.

When a definition goes into a kit (`/api/harness/kit`, `office-harness --kit`, a recommendation), the server adds its parts after it:
- Every part is pinned by its own SHA-256.
- A part is carried only once, even when it is also chosen on its own.
- A script part of a `node` definition in `scripts/` gets `requires: ["command:node"]`.

The limit of 24 resources and 96 KiB counts the parts too. Opora sees a normal `harness.kit/1`, so it needs no change.

## Into a card, then to a worker

Once a package is verified, **Poslat do karty v Opoře** (Schránky → Balíček) proposes it into one card of the bound Opora plan (`POST /api/harness/propose`).

The orchestrator does the same with `office-harness --propose CARD-KEY PROBLEM id …`. CARD-KEY is the namespaced card key from `--hierarchy`. Only an administrator's active orchestrator may do it.

What happens on the way:
1. The office reads `GET /api/oporahub/changesets/context`.
2. It posts a changeset for that card (`POST /api/oporahub/changesets`). The card's goal, non-goals, acceptance and steps stay as they are; only `fields.harness` changes.
3. A person accepts the change in Opora (Plán → Návrhy změn). An agent cannot accept it.
4. A worker that claims the card gets exactly that kit in its assignment (context protocol v2; see [harness.md](harness.md#accepted-tool-kits)).
5. The worker reads it with `office-harness --accepted-kit`.

Each card carries its own package, so workers work with their own equipment independently.

The proposal is refused when:
- the floor is not bound to Opora,
- the card belongs to another project or workspace,
- the plan has no accepted baseline,
- the card has no accepted specification.

Opora's own checks (revision, graph digest, kit validation) answer with 409.

## Running the defined things

- **`ts-refs.mjs`** starts the repository's TypeScript 7 language server (`tsc --lsp --stdio` from `node_modules`) and asks it for the definition or every reference of a symbol.
  - It opens the declaration and every file that names the symbol, and prints sorted `file:line:col` lines. A run takes about half a second.
  - `node .harness/scripts/ts-refs.mjs refs resourceModel`
- **`typecheck-changed.mjs`** is the `PostToolUse` hook. After an edit of a `.ts` file it type-checks that file's project.
  - When the types are fine it exits 0.
  - Otherwise it exits 2 with at most 20 errors on stderr, the edited file's own errors first. That is how a hook shows them to the model.

Both scripts start a process (the language server, `tsc`), so they run in the worker's checkout. The read-only `office-harness --invoke-node` adapter allows no child processes and refuses them.

The office does not yet install hooks into a worker's runner configuration by itself. A worker reads the hook from its accepted kit; installing it automatically is the next step.

## Verification

```
node --import tsx --import=#tests/css --test tests/harness-items.test.ts
```

The test covers:
- the repository's own definitions,
- every way a definition is refused,
- a skill bringing its three parts into a kit,
- a proposal that keeps the card's specification,
- each refused proposal.

`tests/harness-boxes.browser.mjs` shows a definition with its parts and sends the kit into a card through a fixture Opora.
