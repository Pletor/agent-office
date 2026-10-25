# Harness: co dnes funguje a co zbývá

Knihovna je od 25. 10. 2026 v hlavní linii kanceláře i Canvasu. Nové části jsou ve výchozím
stavu vypnuté (viz [Zapnutí v provozu](#zapnutí-v-provozu)). Hlavní cíl samoučící knihovny
zůstává otevřený: tři vazby smyčky chybí a přínos není prokázán. Původní návrh H01–H24 a jeho historii zachovává [kontrakt učení](harness-learning.md).

## Jak se v knihovně orientovat

1. Otevřete Harness klávesou **F8** a vyberte projekt.
2. V pracovní výbavě zvolte **Globál → Projekt → Stránka → Vrstva → Oblast → Sektor → Karta**.
   Zobrazují se úrovně, které skutečně existují v připojené Opoře. Zaškrtnutí přidá
   prostředek, vypnutí potlačí děděnou volbu a **Dědit** obnoví nadřazenou volbu.
   Změna se uloží až tlačítkem **Uložit výbavu**.
3. Rozbalte **Zkušenosti a úspěšnost nástrojů**, vyplňte typ problému z knihovny
   a načtěte výsledky. Sledujte verzi, počet různých karet, neznámé výsledky,
   interval a případné regrese. Samotné procento nestačí.
4. Agent může použít `office-harness --recommend PROBLEM --task KEY` a prohlédnout
   navrženou výbavu, požadavky a důvody. `--search`, `--read` a `--bundle` slouží
   k dohledání a přečtení dostupných prostředků.

Příklad: **5/5 lidsky potvrzených výsledků** znamená 100 % ze známých výsledků
konkrétní konfigurace. Není to záruka dalšího výsledku ani důkaz zavolání každého
nástroje ve výbavě. Znovuotevření jednoho výsledku změní vzorek na 4 potvrzené
a 1 neznámý. Přesně navázaný incident může verzi vyřadit z automatického výběru,
aniž by přepsal původní historii potvrzení.

## Implementace a hranice důkazů

| Oblast | Implementované chování | Ještě nedoložené nebo nedokončené |
| --- | --- | --- |
| Hierarchie a UI | Sedm úrovní, původ voleb, explicitní ukládání, skutečná geometrie Canvasu, ochrana před starým zápisem a souběhem | Produkční nasazení větve |
| Kategorie | Instrukce, skills, pravidla, hooks, commands, scripts, tools, MCP, memory, plugins, permissions, testing, operations | Spuštění každé kategorie neplyne z její přítomnosti v katalogu |
| Verze | Přesný obsah a SHA-256, neměnný přijatý kit; volitelný registr používá jmenný prostor a relativní cestu, takže přesun checkoutu zachová ID | Přesun prostředku na jinou relativní cestu není automatické sloučení jeho historie; samotné pořadové číslo verze není důkaz kvality |
| Samostatný výběr | Typ problému, děděné volby, vypnutí automatického výběru, kompatibilní deklarované požadavky, nejvýše jeden nedostatečně změřený doplněk | Skutečné ověření schopností konkrétního runneru před každým během |
| Tvorba postupů | Publikované projektové/shared prostředky a toolbox deskriptory; párové zkoušky přijatých Node skriptů, samostatné nativní ověření v kontejneru a omezený rozpočet experimentů | Automatické globální publikování na základě důkazů z více projektů |
| Kontext karty | Kit vstupuje do přijatého `fields.harness`; context v2 ho znovu ověřuje, běžící zadání nedostává živé doplňky | Úplná historie politiky výběru a původu všech voleb přímo v kitu |
| Výsledky | Oddělená hlášení agenta a přiřaditelné lidské uzavření sloučeného běhu; jedno hlasování na běh/úroveň důkazu | Obecná atestace skutečných volání, úplných acceptance kontrol a příčinného přínosu |
| Měření | Počty, neznámé výsledky, pokrytí, Wilsonův 95% interval, různé karty, přesná verze a typ problému | Živá historická agregace po všech sedmi úrovních; ostatní neměřené veličiny zůstávají neznámé |
| Regrese | Vazby na existující incidenty/reverty při shodném běhu, revizi, PR, headu a merge SHA; automatický výběr je potlačen, ruční volba má varování | Měřená doba produkčního provozu, vyhodnocená okna přežití a prokázaná příčina |
| Stabilní doporučení | Čerstvé nativní posouzení přesné verze před výběrem, pozastavení a kompatibilní návrat; odmítnuté verze zůstávají vyřazené i po dalších doporučeních a zkrácení auditu | Produkční ověření; dostupná způsobilost pro deterministické Node zkoušky není obecná atestace všech kategorií |
| Context7 | Skutečné MCP initialize/list/call, verzované ID knihovny, čas a hash dokumentace, omezený přenos a rozpočet | Dokumentace není ověření vytvořeného kódu |
| OpenViking | Nativní výsledky a nezávisle ověřené zkoušky vstupují do trvalé fronty; skutečné doručení a přesné načtení byly ověřeny v izolovaném pilotu s existujícím klíčem role | Produkční pilot; doručení nebo přesné načtení samo nepotvrzuje dokončenou vektorovou indexaci |
| Globální sdílení | Výslovný shared katalog a přenosná identita; volitelná nativní politika ověřuje stejnou verzi/problém nejméně ve třech projektech a dvou připnutých obrazech Node. Doporučení může kandidáta nabídnout jinému projektu; přijatý pracovník může načíst jeho aktuální zkušenost z OpenVikingu | Není nasazeno jako celek. Historie z cizího projektu se nepřičítá k místní úspěšnosti; zkoušky samy nepovolují globální produkční povýšení |
| Náklady a odolnost | Neměřené tokeny, ceny, runner a doby běhů se nevymýšlejí; testy pokrývají rollback, opakování, souběh, ztracenou odpověď a změny kontextu | Úplná provozní telemetrie, opakované nezávislé zkoušky a kalibrace experimentální politiky |

Paměť uchovává zkušenost s původem. Před opětovným použitím musí agent ověřit
aktuální nativní výsledky **i varovné signály regresí** pro přesnou verzi.

## Kde se knihovna propisuje

| Příjemce | Co dostane | Hranice |
| --- | --- | --- |
| Člověk v Office | F8, kategorie, hierarchii, checkboxy, původ voleb a zkušenosti | Uložený profil nemění již běžící zadání |
| Orchestrátor | Doporučený kit pro typ problému, požadavky, důvody a dostupnou nativní evidenci | Návrh prochází existujícím přijetím zadání v Opoře |
| Karta v Opoře | Přesný obsah a digest prostředků v přijatém `fields.harness` | Aktualizace knihovny nemění neměnnou výbavu běhu |
| Pracovník | `--accepted-kit`, volitelné `--prepare-accepted` a podporované `--invoke-node` | Příprava ověřuje čitelnost kontextu a dostupnost omezeného Node runneru; jiné adaptéry zůstávají nedostupné |
| Další úkol | Aktualizovaná doporučení, nejistotu, varování a potlačení regresí | Výsledek celé výbavy neprokazuje přínos každé položky |
| OpenViking | Zkušenost s původem a přesnými odkazy na důkazy | Historický zápis může zůstat uložený, ale odvolaný důkaz nelze použít jako aktuálně způsobilý |

Pracovník s odpovídajícím přijatým Node prostředkem může použít
`office-harness --recall-shared PUBLICATION --resource RESOURCE`.
`--publish-shared` používá stejnou identitu publikace a prostředku; potvrzení
fronty ještě není potvrzené načtení. ID publikace pochází z volitelného
`candidates[].shared.publication` v doporučení. Příkazy vyžadují modul
z Office #62 a odpovídající nativní moduly Canvas #46/#78. Veřejný požadavek
neposílá token pracovního běhu. Důkazy se kontrolují před operací i po ní
a přijatá výbava zůstává beze změny.

## Zapnutí v provozu

Bez proměnných prostředí worker dostane jen živý snímek profilu (kontext v1). Celý řetězec
přijatá výbava → příprava → měřené použití → učení potřebuje obě strany:

| Proměnná | Kde | Výchozí | Pro zapnutí |
| --- | --- | --- | --- |
| `AGENT_OFFICE_OPORA_CONTEXT_VERSION` | Office | v1 | `2` |
| `AGENT_OFFICE_HARNESS_PREFLIGHT` | Office | vypnuto | `1` (kontrola přijaté výbavy před claimem) |
| `AGENT_OFFICE_OPORA_PREPARE_WORKER` | Office | vypnuto | `1` (pracovní adresář workera před claimem) |
| `AGENT_OFFICE_HARNESS_PREPARE_WORKER` | Office | vypnuto | `1` (příprava výbavy před startem providera; vyžaduje `AGENT_OFFICE_OPORA_PREPARE_WORKER=1` a kontext v2, jinak start selže s chybou) |
| `AGENT_OFFICE_HARNESS_MCP` | Office | vypnuto | `1` (nástroje výbavy v Office MCP; kancelář ho předá workerům) |
| `CONTEXT7_API_KEY` | Office | nenastaveno | volitelné, vyšší limity Context7 |
| `OPORA_HARNESS_VERIFIER` | Canvas | prázdné = vypnuto | JSON rozsahů a připnutý obraz Node |
| `OPORA_HARNESS_STABILITY` | Canvas | prázdné = vypnuto | JSON rozsahů a schválené digesty plánů |
| `OPORA_HARNESS_EXPLORATION` | Canvas | prázdné = vypnuto | JSON rozsahů, jen `nonproduction` |
| `OPORA_HARNESS_TRANSFER` | Canvas | prázdné = vypnuto | JSON pro sdílení mezi projekty |
| `OPORA_OPENVIKING_ENABLED` | Canvas | false | `1` a klíče rolí (`provision_roles`) |

Pořadí: nasaďte Canvas i Office ze stejného dne (`aktualizovat-vse.ps1`), zapněte Office
proměnné na jednom patře, ověřte jednu kartu s přijatou výbavou a teprve potom politiky Canvasu.
Vypnutí proměnné vrací původní chování; uložené profily a historie zůstávají.

Ještě chybí: automatický zápis doporučeného kitu do návrhu karty, spouštěč nezávislého
ověření po výsledku a návrat paměti z OpenVikingu do doporučení.

## Kde je změna

Sloučeno 25. 10. 2026: Office #48, #55, #56, #57, #60, #62–#65, #69, #72, #80, #84–#86,
#90–#96 a Canvas #46, #74, #78, #82. Staré návrhy #22–#31 zůstávají otevřené
k rozhodnutí; jejich nepřevzaté části popisuje audit knihovny.

Novější izolovaná zkouška prošla skutečným spuštěním připnutého skriptu, šesti
nezávislými kontejnerovými pokusy, nativním přijetím výsledku bez duplicity při
opakování a zápisem do skutečného OpenVikingu s přesným načtením zpět. Další zkouška
ověřila automatický návrat na předchozí verzi a 22 dalších doporučení bez návratu
odmítnutého nástroje. Historická lidská potvrzení a vazby na sloučené PR použité
pro vzorek jsou stále simulované. Výsledek konkrétní zkoušky není produkční přijetí
ani statistický důkaz příčinného přínosu. Přesné commity, příkazy a výstupy jsou u PR.

Další izolovaný pilot ověřil 18 skutečných kontejnerových pokusů ve třech
projektech a doporučení do čtvrtého. Přijatý pracovník přes skutečné CLI načetl
sdílenou zkušenost z živého OpenVikingu, zopakoval publikování bez duplicity,
odmítl načtení po odvolání zdrojových důkazů a uspěl po jejich obnovení.
Historická lidská uzavření a identita aktéra v testovacím HTTP serveru byly
simulované; nešlo o autonomní LLM řešení produkčního úkolu.

Při předání orchestrátoru je třeba rozlišovat tři věci: katalog říká, co lze najít,
doporučení navrhuje výbavu pro problém a přijatý kit určuje neměnnou výbavu konkrétního
běhu. Úspěšné čtení katalogu ani doporučení nepotvrzuje připravenost všech schopností
runneru. Globální dostupnost sdíleného prostředku nepřenáší automaticky jeho
úspěšnost mezi projekty. Výslovně publikovaná nativní evidence může být podkladem
pro místní ověření v jiném projektu, zatímco místní výsledky zůstanou neznámé.

Nasazení musí ověřit server i klienta. Sloučení samo o sobě nesplňuje celý původní cíl.
