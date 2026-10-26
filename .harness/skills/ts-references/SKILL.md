---
name: ts-references
description: Najdi definici a všechna použití symbolu v TypeScriptu přes jazykový server repozitáře, ne grepem. Použij před změnou funkce, typu nebo konstanty.
---

# Reference v TypeScriptu

1. Zjisti přesný název symbolu (funkce, typ, konstanta).
2. Spusť `node .harness/scripts/ts-refs.mjs refs NÁZEV`. Výstup jsou seřazené řádky `soubor:řádek:sloupec`, první je deklarace.
3. Každé místo otevři a rozhodni: mění se, nebo ne a proč. Nepřeskakuj testy a sdílené typy (`src/shared/`).
4. Po úpravě se typy zkontrolují samy (hook `typecheck-on-edit`); když ne, spusť `npm run typecheck`.
5. Ve výsledku uveď, kolik míst skript vrátil a kolik jsi změnil.

Když skript skončí kódem 1, symbol v `src/` deklarovaný není (externí knihovna, překlep). Kód 2 je chyba prostředí: chybí `npm install`.

Proč ne grep: viz [references/lsp-vs-grep.md](references/lsp-vs-grep.md).
