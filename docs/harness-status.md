# Harness: co dnes funguje a co zbývá

Stav review větví, nikoli potvrzení nasazení. Hlavní cíl samoučící knihovny zůstává
otevřený. Původní návrh H01–H24 a jeho historii zachovává [kontrakt učení](harness-learning.md).

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
| Verze | Přesný obsah a SHA-256; konfigurace zahrnuje kategorii a požadavky; neměnný přijatý kit | Přenosná stabilní identita původního registru H03 není v této vlně obnovena; katalogová ID závisejí na cestě |
| Samostatný výběr | Typ problému, děděné volby, vypnutí automatického výběru, kompatibilní deklarované požadavky, nejvýše jeden nedostatečně změřený doplněk | Skutečné ověření schopností konkrétního runneru před každým během |
| Tvorba postupů | Publikované projektové/shared prostředky a verzované toolbox deskriptory; agent upravuje prostředky v oprávněném checkoutu | Řízené párové experimenty a automatické povýšení do širšího rozsahu |
| Kontext karty | Kit vstupuje do přijatého `fields.harness`; context v2 ho znovu ověřuje, běžící zadání nedostává živé doplňky | Úplná historie politiky výběru a původu všech voleb přímo v kitu |
| Výsledky | Oddělená hlášení agenta a přiřaditelné lidské uzavření sloučeného běhu; jedno hlasování na běh/úroveň důkazu | Obecná atestace skutečných volání, úplných acceptance kontrol a příčinného přínosu |
| Měření | Počty, neznámé výsledky, pokrytí, Wilsonův 95% interval, různé karty, přesná verze a typ problému | Živá historická agregace po všech sedmi úrovních; ostatní neměřené veličiny zůstávají neznámé |
| Regrese | Vazby na existující incidenty/reverty při shodném běhu, revizi, PR, headu a merge SHA; automatický výběr je potlačen, ruční volba má varování | Měřená doba produkčního provozu, vyhodnocená okna přežití a prokázaná příčina |
| Context7 | Skutečné MCP initialize/list/call, verzované ID knihovny, čas a hash dokumentace, omezený přenos a rozpočet | Dokumentace není ověření vytvořeného kódu |
| OpenViking | Nativní potvrzení a odvolání vstupují transakčně do trvalé fronty; role, lease, opakování a neměnné adresy | Živý produkční pilot; přijetí HTTP zápisu nepotvrzuje dokončenou indexaci |
| Globální sdílení | Výslovně publikovaný shared adresář je dostupný agentům více pater; osobní adresáře se takto nezveřejní | Automatické globální publikování a sdílení výsledků mezi projekty nejsou zapnuté |
| Náklady a odolnost | Neměřené tokeny, ceny, runner a doby běhů se nevymýšlejí; testy pokrývají rollback, opakování, souběh, ztracenou odpověď a změny kontextu | Úplná provozní telemetrie, opakované nezávislé zkoušky a kalibrace experimentální politiky |

Paměť uchovává zkušenost s původem. Před opětovným použitím musí agent ověřit
aktuální nativní výsledky **i varovné signály regresí** pro přesnou verzi.

## Kde je změna k revizi

- [Office #48](https://github.com/Pletor/agent-office/pull/48): vyhledání, čtení,
  sestavení a doporučování kitu, offline replay, shared publikování, regrese.
- [Office #55](https://github.com/Pletor/agent-office/pull/55): sedm úrovní,
  checkboxy, bezpečné ukládání a přehled zkušeností.
- [Office #56](https://github.com/Pletor/agent-office/pull/56): Context7.
- [Canvas #46](https://github.com/Pletor/opora-control-center-canvas/pull/46):
  přijatý kit, nativní výsledky, regrese a doručování paměti.

Izolovaná zkouška prošla sestavením skutečného kitu, pěti připnutými Node běhy
na různých kartách, nativní evidencí, HTTP doručením paměti a dalším doporučením.
Potvrzení karet a přijímač OpenVikingu byly testovací náhrady. Není to produkční
pilot ani lidské schválení nasazení. Přesné commity, příkazy a výstupy jsou u PR.

Větve se slučují přes lidskou frontu podle [Čisté linie](cista-linie.md), po jednom,
s přeložením dalších větví na nový main. Nasazení musí ověřit server i klienta.
Otevření těchto PR samo o sobě nesplňuje celý původní cíl.
