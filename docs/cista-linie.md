# Čistá linie — jak PR vznikají, synchronizují se a uklízí

Platí pro agent-office i Opora Canvas, pro lidi, hlavní sessions i subagenty. Cíl: jedna aktuální linie `main`, krátké větve, které se slučují ve známém pořadí, nasazení, které po sloučení vždy odpovídá `main`, a úklid, který dělá vlastník hned. Nikdo nedělá práci navíc, nikdo nikomu nic nemaže pod rukama a nikdo nevymýšlí, jak něco obejít.

## 1. Co se pokazilo (retro 21.–22. 10. 2026)

| # | Co se stalo | Dopad | Příčina |
|---|-------------|-------|---------|
| 1 | PR #379 vznikl v cizím repozitáři (AgentSystemLabs) | práci bylo nutné převzít, upstream PR zůstal viset | v agent-office je `origin` = cizí upstream, skutečná linie je `fork` |
| 2 | Vlastní úložiště událostí vedle už sloučeného outboxu (#26) | backend se psal dvakrát | o záměru se nevědělo, chyběl krok „najdi, co už existuje“ |
| 3 | Řetězené PR (Harness H01→H13 devět pater, #33/#34/#35) sloučené mimo pořadí | `rebase --onto`, zavřené zbytečné PR, „dirty“ PR | squash merge rozbíjí řetězy, pořadí nikdo nedržel |
| 4 | Backend Opory přeskládaný 3× (eea2307 → main → #32 → main) | hodiny práce navíc | práce na pohyblivém cíli bez vlastníka pořadí |
| 5 | Horká místa (`opora_agent_state.py`, `factory.py`, `App.tsx`, registry) | konflikt po každém sloučení | víc PR naráz v jednom souboru bez vlastníka |
| 6 | 8740/4600 hodiny na starém commitu; po #39 nový server, ale **starý klient** | „změny se neprojevily“ | skript předpokládal, že `tsx watch` přenačte vše; klient z `dist/public` se nestavěl |
| 7 | Rozbité `node_modules` v hlavním checkoutu, `npm ci` → EPERM, šum v lockfile | build padal, Opora minutu dole | instalace pod běžícím procesem, ruční zásahy do hlavního checkoutu |
| 8 | Úklid: mazání blokované, jiná session smazala větve pod rukama, zbytky složek, ~40 mrtvých větví | zmatek, ruční dohledávání | nikdo nevlastnil úklid, chyběla automatika i registr worktree |
| 9 | Auto mode blokuje merge/close/rebase/force-push/kill | uživatel ručně přepisuje příkazy | lidský krok neměl tlačítko, agent neměl práva na vlastní větev |
| 10 | Rate limit uprostřed vlny | 5 agentů stálo | žádná rezerva ani pořadí priorit |

## 2. Pravidla

### 2.1 Jedna linie na repozitář
- Pravda je `main` na **Pletor**. agent-office: remote `fork` (doporučeno přejmenovat na `origin`), Canvas: `origin`. AgentSystemLabs je `upstream` **jen pro čtení**: `git remote set-url --push upstream DISABLED`.
- **Hlavní checkout je jen pro nasazení.** Nikdo v něm nevyvíjí, necommituje ani ručně neinstaluje. Mění ho jen nasazovací skript (`aktualizovat-vse.ps1`).

### 2.2 Záměr před kódem
- Každá práce začíná **kartou v Opoře** (lease = vlastník) a **ohlášením záměru**: jaké soubory a oblasti, jaká data a API. Bez ohlášení se nestaví nová infrastruktura.
- Před stavbou hledej, co už je: `main`, otevřené PR, ohlášené záměry, `docs/`.
- **Horká místa mají jednoho vlastníka na vlnu** (seznam drží orchestrátor: agent-state, factory, schema, App.tsx, protocol/registry). Ostatní do nich jen přidávají řádek do registru.

### 2.3 Malé PR přímo z čerstvého main, žádné řetězy
- Větev `<oblast>/<téma>` z čerstvého `main`, jedna věc, ideálně do dne práce a do ~400 změněných řádků.
- Závisí-li B na A: **nejdřív se sloučí A**, nebo B jde za přepínačem. Řetěz jen výjimečně, s vyznačeným pořadím a jedním vlastníkem vlaku.
- Před otevřením PR i před sloučením: `git fetch && git rebase origin/main`. Žádné merge commity `main` do větve.
- Jedna session = jeden worktree = jedna větev = jeden PR.

### 2.4 Fronta slučování
- Sloučit lze jen **zelené** PR: typecheck/testy/build, review a diagram PR Lens. Slučuje se v pořadí fronty, squash, jeden vlastník fronty na repozitář.
- Člověk slučuje **jedním tlačítkem v Boss Office** (tabule Čistá linie ukazuje, který PR je na řadě a proč). Vlastník fronty pak další PR přeskládá na nový `main`.
- GitHub: **Automatically delete head branches** zapnuto v obou repozitářích.

### 2.5 Nasazení je součást sloučení
- Po každém sloučení: `ff pull` → závislosti a build **vedle**, ne pod běžícím procesem → **build klienta i serveru** → restart → ověření, že běžící server **i klient** = `main` HEAD.
- Tabule ukazuje drift (server, klient, závislosti). Drift = červená, dokud se nenasadí.

### 2.6 Úklid dělá vlastník, hned
- Kdo vytvořil worktree nebo větev, ten ji po sloučení smaže. Worktree má vlastní složku a vlastní `npm ci`, nikdy junction na hlavní `node_modules`.
- **Nikdo nemaže cizí.** Sirotky (sloučené a nesmazané, opuštěné worktree, 0 commitů) jen hlásí tabule. Smaže je vlastník, nebo člověk jedním potvrzeným tlačítkem „Uklidit“ se seznamem toho, co zmizí.
- `git config --global core.longpaths true`.

### 2.7 Oprávnění
- Agent smí ve **svém** worktree: `git rebase`, `git push --force-with-lease` na svou větev, `git worktree remove` svého worktree.
- Slučování, zavírání cizích PR a mazání cizích větví zůstává člověku, přes tlačítka tabule, ne přes přepisování příkazů.

## 3. Životní cyklus PR

```
karta + záměr → worktree z main (vlastní npm ci) → práce → self-checks
  → rebase na main → PR + diagram PR Lens → review → fronta
  → sloučení (člověk, tlačítko) → nasazení + ověření server/klient = main
  → úklid (vlastník: větev, worktree) → karta hotovo
```

## 4. PR Lens v procesu Opory

**Kde:** etapa **Revize**, hned po otevření PR. Je to vstup pro review (agent i člověk), ne kontrola kvality.

- **Kdo kreslí:** pracovník, který změnu udělal, přes **lokální skill** `coldteadotai/pr-lens` (Claude Code v předplatném). Diagram ověří `npx @coldtea/pr-lens-cli validate`, vykreslí lokálně (jen aby vznikla ověřená specifikace). Specifikace jde do Canvasu jako strukturovaný důkaz, do PR jde krátké textové shrnutí. Žádné obrázky a žádné vedlejší větve `pr-lens/*`.
- **Bez hostované aplikace a bez API klíče:** nepoužíváme GitHub App, `analyze` s cizím modelem ani `canvas push`. Kód zůstává lokálně a platí pravidlo Opory „předplatné, ne API“.
- **V Opoře:** odkaz na diagram je důkaz u review (`evidence.review.lens`). Review karta a Živý proces ho ukazují u PR. Pro profil `code` je to podmínka vstupu do review. Opravy pojmenování patří do `.github/pr-lens.yml`, ne do SVG.
- **Proč tam:** review dnes čte diff naslepo. Diagram ukáže dosah změny (nové, změněné a odebrané části) a tok dat, takže review najde špatné napojení dřív, než se PR dostane do fronty.

## 5. Tabule „Čistá linie“ v Boss Office

Zeď v podkroví: graf commitů jako na GitHubu (linie `main`, větve, sloučení, čísla PR), fronta slučování, zdraví linie (řetězy, pozadu za main, sloučené a nesmazané, sirotčí worktree, špinavý hlavní checkout, drift nasazení server/klient) a tato pravidla. Okno (E) má tlačítka **Sloučit** (jen PR na řadě, zelený) a **Uklidit** (potvrzený seznam).
