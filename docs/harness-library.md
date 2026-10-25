# Harness library workspace

Open the Harness shelf with **E**, or press **F8**. The full-screen workspace is in Czech and in the office's own look (paper, ink borders, Nunito; `styles/base.css`). It has four pages:

- **Přehled** (overview) says in plain words what the library does. A status card for the floor shows the loaded resources, which hierarchy the server supports, whether the floor is bound to Opora, and whether this session may edit. Under it, four steps (Prostředky → Výbava → Příprava → Výsledky), the seven levels, the thirteen categories with their counts, the worker's commands for one card, and the sources found on disk. A successful `harness.hierarchy/1` response confirms the seven-level API and the session's write authority. A 404 identifies the legacy Global → Repository → Task server. Other errors stay errors, never an available capability.
- **Prostředky** (resources) keeps search, category and source filters, plain-text reading and copy/download of an ad-hoc pack (**Zkopírovat balíček**, **Stáhnout balíček**). These selections never change persistent configuration. **Přiřadit do výbavy** switches to Výbava with the resource added to the draft.
- **Výbava** (equipment) is the seven-level editor ([harness-hierarchy.md](harness-hierarchy.md)): pick a level, switch resources on or off, or restore inheritance (**Dědit**), then **Uložit výbavu**. Changing level is blocked while a draft is unsaved.
- **Pro agenty** lists the worker's `office-harness` commands in the order a card uses them (before, during and after the work), each with what it is for. They are references to implemented worker commands, **not browser actions or deployment detection**. The browser has no session API for their runtime state, and unknown production results stay unknown.

Category names are shown in Czech (`library/names.ts`); the catalog keeps its own IDs. Resource titles and texts come from the handbook and the repository and are shown as written.

The top-right **✕** and **Esc** use the office modal and focus lifecycle to resume mouse-look. On a phone the navigation becomes a row of four tabs, and the reader keeps its list/reader panes and keyboard shortcuts. Category counts describe the loaded catalog, including its truncation flag. A source found on disk does not establish a live OpenViking service, an MCP connection or Context7 credentials.

## Composition

`libraryWorkspace(el, () => floor, abort.signal)` wraps the `.harness-cascade` editor that `hierarchyPanel` supplies. `ui.ts` constructs it after the dialog, calls `workspace.catalog(result)` after each successful catalog load (next to `cascade.catalog(result)`), and calls `workspace.show('equipment')` before assigning a resource. The floor getter follows project changes.

The hierarchy API check confirms only server support. Closing the library by ✕ or Esc keeps an unsaved draft in memory (per floor, level, target and base revision), and the next opening returns to Výbava with a notice. A saved profile is planning data: it never mutates an accepted kit or a running execution.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build`. With Vite running on port 5187, run `node tests/harness-workspace.browser.mjs` for desktop/mobile screenshots, real profile-switch payloads, read-only authority, optional hierarchy states, a Výbava draft kept across Esc/✕ and restored with a notice (then saved or discarded), category navigation, export and ✕/Esc. The test uses the actual catalog and reader with isolated route fixtures; it does not prove a production deployment or worker execution.
