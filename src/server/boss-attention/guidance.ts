import type { BossAttentionItem } from '../../shared/boss-attention.js';
import type { OporaState } from '../../shared/protocol/opora.js';
type Guide = NonNullable<BossAttentionItem['guidance']>;

export function questionGuidance(id: string, stage = false): Guide {
  return {
    owner: 'Ty — rozhodnutí nebo doplnění podkladu', activity: 'Čeká na tvoji odpověď', blockers: [],
    linkLabel: 'Otevřít kartu a odpovědět v Opoře',
    steps: stage ? [
      'Otevři kartu tlačítkem níže a na kartě rozklikni „pipeline“.',
      `Najdi selhanou etapu ${id} a přečti její výsledek. Rozhodni, zda zadání upřesnit, nebo povolit další pokus; nepřeskakuj kontroly jen kvůli uzavření.`,
      'Rozhodnutí zapiš do zadání karty. Případný další pokus musí převzít orchestrátor; samotné přečtení ani uzavření tabule nic nespouští.',
      'Po uložení v Opoře se vrať sem a stiskni „Obnovit“. Pokud položka zůstává, požadavek ještě nebyl v Opoře vyřešen.',
    ] : [
      'Otevři kartu tlačítkem níže. Na kartě rozklikni blok, ke kterému se otázka vztahuje.',
      `Požadavek patří bloku ${id}. Do jeho „Text bloku“ doplň odpověď a potřebné odkazy, původní zadání zachovej. Kliknutím mimo pole se text uloží.`,
      'Pokud jsi dodal požadovaný vstup, přepni stav bloku z „blokováno“ na „otevřeno“, aby práci mohl převzít agent. „splněno“ použij jen při skutečném splnění celé podmínky bloku.',
      'Po úspěšném uložení v Opoře se vrať sem a stiskni „Obnovit“. Při chybě uložení není odpověď potvrzená.',
    ],
    expected: 'Po odstranění čekání na člověka položka zmizí při novém načtení (cache až 15 s). To ještě neznamená dokončení úkolu ani automatické spuštění agenta.',
  };
}

export function approvalGuidance(): Guide {
  return {
    owner: 'Ty — převzetí výsledku', activity: 'Podklady připraveny ke kontrole; uložení povoluje Opora', blockers: [],
    linkLabel: 'Zkontrolovat a převzít v Opoře',
    steps: [
      'Otevři kartu v Opoře. V „Zadání“ přečti podmínky dokončení; v „Podrobnosti“ na kartě otevři doklady testů, review a merge.',
      'Vyzkoušej výsledek podle podmínek dokončení. Pokud chybí dostupná testovací verze nebo potřebný podklad, nic nepotvrzuj — doplň připomínku do zadání.',
      'Pokud vše odpovídá, použij na kartě „Potvrdit“. Pokud ne, ponech kartu otevřenou a do zadání zapiš konkrétní chybu, kroky reprodukce a očekávaný výsledek.',
      'Ověř, že Opora ukazuje „Uzavřeno“ a nehlásí chybu uložení. Potom se vrať a stiskni „Obnovit“. Pokud je potvrzení zakázané, přečti aktuální důvod v Opoře — neobcházej jej.',
    ],
    expected: 'Teprve uložené potvrzení v Opoře odebere návrh ze seznamu a může odblokovat závislé karty. Připomínka sama nezakládá opravného workera.',
  };
}

export function systemGuidance(state: OporaState, nodeId?: string, blockers: string[] = []): Guide {
  const run = nodeId && state.runs.find((r) => r.cardId === nodeId && r.workspace === state.workspace && r.state === 'working' && !r.error && !!r.workerId);
  return {
    owner: 'Orchestrátor / agenti — nikoli tvoje převzetí',
    activity: run ? `Most hlásí aktivní běh: ${run.workerName || run.workerId}. Neověřuje, zda právě opravuje tento problém.` : 'Není doložen aktivní běh na této kartě. Tabule opravu nezadala.',
    steps: [], blockers,
    agentNext: 'Orchestrátor má ověřit příčinu a přidělení práce, zajistit dokončení chybějících etap a dokladů a teprve potom předložit výsledek k převzetí. Tento postup ještě není spuštěný příkaz.',
    expected: 'Až budou podmínky doplněné a agent znovu navrhne dokončení, objeví se zde tvůj postup převzetí. Tabule stav sama nemění.',
    linkLabel: 'Zobrazit stav karty (jen informace)',
  };
}
