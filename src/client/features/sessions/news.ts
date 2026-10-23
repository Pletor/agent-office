// The third screen's static content: the Novinky strip (the ClaudeDevs thread of 14 Oct 2026 on Claude
// Code desktop running many sessions at once, and its docs), and where each part of the screen gets its
// data: what the office knew already (D), what's worked out from it (O), and what it reads now that it
// didn't before (N: the transcripts' checklists, sub-sessions, context, summaries).

export const NEWS_HEAD = 'Claude Code desktop · více relací najednou · ClaudeDevs, 14. 10. 2026';
export const NEWS_DOCS = 'https://code.claude.com/docs/en/desktop';

export const NEWS: { t: string; d: string; use: string; u: string; video?: boolean }[] = [
  { t: 'Rychlejší start a dělení práce', d: 'Relace startují rychleji, práce jde rozdělit mezi víc relací a je vidět, co která dělá.', use: '→ celá tahle obrazovka', u: 'https://x.com/ClaudeDevs/status/2110445844675838148', video: true },
  { t: 'Uložená prostředí', d: 'Několik složek, SSH nebo cloud, worktree pro každou složku; nedávné složky na jedno kliknutí.', use: '→ „Kde běží“ v detailu relace', u: 'https://x.com/ClaudeDevs/status/2110445846219382954' },
  { t: 'Vnořené relace hlásí nahoru', d: 'Paralelní úkoly běží jako vnořené relace, výsledek posílají hlavní relaci a ta zůstává čitelná.', use: '→ strom pod-relací a ↑ hlášení', u: 'https://x.com/ClaudeDevs/status/2110445847922245974' },
  { t: 'Navazující práce a /btw', d: 'Claude navrhne další práci, spustíš ji jako vlastní relaci jedním kliknutím; /btw otevře boční otázku v záložce.', use: '→ 💡 Navazující práce, /btw uzly', u: 'https://x.com/ClaudeDevs/status/2110445849516101743' },
  { t: 'Kdo pracuje a kdo tě potřebuje', d: 'Postranní lišta, živý seznam úkolů, souhrnná karta, když Claude potřebuje tebe, a panel s kontextem a změnami.', use: '→ stavy, plán, detail relace', u: 'https://x.com/ClaudeDevs/status/2110445851466485786' },
  { t: 'Jak začít', d: 'Aktualizuj desktopovou aplikaci a otevři novou relaci.', use: '→ návod v dokumentaci', u: 'https://code.claude.com/docs/en/desktop-quickstart' },
];

export const SOURCES: Record<'d' | 'o' | 'n', [string, string][]> = {
  d: [
    ['Stůl, jméno, stav relace', 'WorkerInfo.status, deskId, waitingSince, acked'],
    ['Úkol a jeho shrnutí od malého modelu', 'WorkerInfo.task (server/tasks.ts)'],
    ['Poslední akce a její druh', 'WorkerInfo.activity, action'],
    ['Tokeny, cena, model', 'WorkerInfo.usage (server/usage.ts)'],
    ['PR, větev, worktree; checky PR', 'WorkerInfo.pr, worktree; GhPull.checks'],
    ['Karta Opory u relace, zámek, stav karty', 'OporaRun (state, leaseUntil), OporaCard.status'],
    ['Claude limit a denní rozpočet', 'PlanLimits, UsageState.budget'],
    ['Změny relace (soubory)', 'ChangesState přes changes.watch'],
    ['Sirotčí worktree, sloučené a nesmazané větve', 'cleanline HealthFlag'],
  ],
  o: [
    ['„Bez pohybu X min“', 'nejnovější z žurnálu (refs.workerId), přepisu a stavu'],
    ['Slepá ulička: testy padají opakovaně, hotovo bez PR, spí bez probuzení, pod-relace stojí', 'status + action „failing“ + pr + čas'],
    ['Sirotci: karta se zámkem bez relace, relace bez karty', 'OporaRun gone + leaseUntil; relace bez OporaRun'],
    ['Společný cíl a % hotovo ve 3 úrovních', 'zaměření buňky + plán Lens z Opory (withCode, confirmed)'],
    ['Další karty na řadě', 'OporaCard ready + frontier bez běhu'],
  ],
  n: [
    ['Pod-relace jako uzly stromu, hlášení nahoru', 'nástroj Agent v přepisu + subagents/*.meta.json, <task-notification>'],
    ['/btw boční otázky jako vlastní uzly', 'příkaz /btw v přepisu'],
    ['Živý seznam úkolů relace', 'TodoWrite / TaskCreate / TaskUpdate z přepisu'],
    ['Souhrnná karta „potřebuje tě“', 'hook Notification / PermissionRequest + čekající nástroj'],
    ['Navazující práce + spuštění jedním kliknutím', '„Další kroky“ z poslední zprávy → fronta úkolů'],
    ['Plnění kontextového okna', 'usage posledního tahu v přepisu'],
    ['Souhrn posledního tahu', 'away_summary Claude Code'],
    ['Pás Novinky', 'statický obsah'],
  ],
};
