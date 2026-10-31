# Boss Office — 🗂️ Výstupy · Čistá linie

Back to the [README](../README.md). Sousedí s tabulí [Čistá linie](clean-line-board.md) a řídí se procesem [Čistá linie](cista-linie.md).

Karta stojí v Boss Office (loft, nahoře po schodech) na podlaze pod tabulí Čistá linie, ve stejné podobě jako karta orchestrátora: nízký skloněný pult s fialovým rámem na tmavém podnosu. Ukazuje, **co se na hlavní linii za posledních 7 dní změnilo a postavilo a jak vypadá výsledek**. Nic nesmí zapadnout: každý sloučený PR buď má výstup, nebo je viditelně označený „bez výstupu“.

## Kontrakt výstupu

Výstup PR je **sekce `## Výstup` v těle PR**. Nic jiného se nečte a nic nového se neukládá.

```markdown
## Výstup
Artefakt: <https://claude.ai/artifact/…>
Před: ![](https://github.com/user-attachments/assets/…)
Po: ![](https://github.com/user-attachments/assets/…)
Diagram: ![](https://raw.githubusercontent.com/<owner>/<repo>/<sha>/docs/obrazky/lens.gif)
Diagram: [PR Lens](https://claude.ai/artifact/…)
```

Pravidla čtení (čistá funkce `parseOutputs` v `src/shared/outputs.ts`, test `tests/outputs.test.ts`):

1. Sekce začíná řádkem `## Výstup` (velikost písmen nehraje roli, mezery na konci také ne) a končí dalším nadpisem úrovně 1 nebo 2 (`#` / `##`) nebo koncem těla. Nadpisy `###` a hlubší patří do sekce.
2. Řádek je `<Klíč>: <hodnota>`, smí začínat odrážkou `- ` nebo `* `. Klíče: `Artefakt`, `Před` (také `Pred`), `Po`, `Diagram`. Ostatní řádky se ignorují.
3. Hodnota je první URL z: obrázku `![alt](url)`, HTML `<img src="url">` (to vkládá GitHub při přetažení obrázku), odkazu `[text](url)`, `<url>` nebo holé `https://…`. Bere se jen `http(s)`.
4. `Artefakt` a `Diagram` se smí opakovat (všechny se ukážou, v pořadí). `Před` a `Po` platí první výskyt.
5. **Obrázek** (`<img>`) se ukáže jen tehdy, když je napsaný jako obrázek (`![]()` nebo `<img>`) **a** jeho adresa je `https` na jedné z domén: `github.com`, `user-images.githubusercontent.com`, `private-user-images.githubusercontent.com`, `raw.githubusercontent.com`, `claude.ai`. Cokoli jiného se ukáže **jen jako odkaz**, nikdy jako `<img>`.
6. PR **bez sekce**, nebo se sekcí bez jediného platného řádku, je **„bez výstupu“**.

## Data

`GET /api/cleanline/outputs?floor=<id>&repo=floor|office` (přihlášený prohlížeč), odpověď `OutputsBoard` (`src/shared/outputs.ts`):

- Repozitář a hlavní větev bere ze stejných dat jako tabule Čistá linie (`cleanLine` v `src/server/cleanline/index.ts`): jeho GitHub adresu a graf commitů hlavní linie.
- Sloučené PR za posledních 7 dní do hlavní větve čte jedním dotazem do vyhledávání GitHubu: `gh api graphql -f query=<MERGED_QUERY> -f q="repo:<owner/name> is:pr is:merged base:<main> merged:>=<datum>"` (pevné argumenty, bez shellu, stejný runner jako Čistá linie; nejvýš 100 PR a 50 commitů na PR). `gh pr list --json commits` se nepoužívá, protože se ptá i na autory commitů a GitHub dotaz odmítne jako příliš velký.
- Ke každému PR: číslo, název, odkaz, datum sloučení, autor, commity PR (krátký sha a první řádek zprávy), squash commit na hlavní linii a výstupy.
- **Nic nezapadne:** squash commity hlavní linie z grafu Čisté linie s `(#N)` za posledních 7 dní, které `gh` nevrátil (není přihlášený, výpadek), se přidají jako PR „bez výstupu“ s poznámkou, že tělo PR nešlo přečíst.
- Výsledek se kešuje na repozitář 15 s, stejně jako Čistá linie (jeden rozpracovaný dotaz sdílí všichni). `refresh=1` keš obejde.
- Chování Čisté linie (sloučení, úklid, fronta) se nemění; karta jen čte.

## Ve světě

- **Pult:** `🗂️ VÝSTUPY · Čistá linie`, počet sloučených PR za 7 dní a kolik z nich má výstup (`12 PR · 9 s výstupem · 3 bez`), a `E · otevřít`. Obnovuje se každou minutu, když je záložka vidět.
- **E** otevře detail. Vpravo nahoře ✕, Esc i ✕ vrací rovnou do ovládání myší.
- **Detail:** seznam PR (nejnovější nahoře) s filtrem „jen bez výstupu“. U PR číslo a název s odkazem na GitHub, datum, commity, štítek „bez výstupu“, nebo výstupy: odkazy na artefakty, „Před / Po“ vedle sebe s přepínačem (vedle sebe · před · po), diagramy a animace (obrázek, nebo odkaz). Klik na obrázek ho otevře ve velkém náhledu.

## Kód

- Kontrakt a parser: `src/shared/outputs.ts`, test `tests/outputs.test.ts`.
- Server: `src/server/cleanline/outputs.ts` (čtení přes `gh`, sestavení, keš), trasa `src/server/http/routes/outputs.ts`, test `tests/outputs-server.test.ts`.
- Klient: `src/client/features/outputs/` (`world.ts` pult, `board.ts` jeho plátno, `detail.ts` okno, `ui.css`, `index.ts`).

## Snímky

[Pult pod tabulí Čistá linie](obrazky/vystupy-svet.png), [detail s PR s výstupem](obrazky/vystupy-detail.png) a [filtr „jen bez výstupu“](obrazky/vystupy-filtr.png). Seznam PR je skutečný (Pletor/agent-office); výstup u #128 je na snímku jen ukázka, protože žádný sloučený PR zatím sekci `## Výstup` nemá.
