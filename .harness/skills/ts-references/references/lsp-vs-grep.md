# Jazykový server, nebo grep

- **Grep** najde text: i komentáře, jiné symboly stejného jména a řetězce. Nenajde přejmenovaný import (`import { a as b }`).
- **Jazykový server** (`tsc --lsp` z TypeScriptu 7 v `node_modules`) zná typy a importy: vrátí jen skutečná použití toho jednoho symbolu.
- Skript otevře serveru deklaraci a každý soubor, kde se jméno vyskytuje; reference jinde být nemůže, takže výsledek je úplný a pro stejný checkout vždy stejný.
- Běh trvá zhruba půl sekundy, takže se vyplatí i u malé změny. Šetří kontext: místo stovek řádků grepu dostane agent jen přesná místa.
