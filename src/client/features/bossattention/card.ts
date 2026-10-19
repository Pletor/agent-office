import type { BossAttentionItem } from '../../../shared/boss-attention';
import type { WorkerInfo } from '../../../shared/protocol';
import { alertDetail } from '../../../shared/status';
import { h } from '../../ui/dom';

export function itemCard(item: BossAttentionItem): HTMLElement {
  const human = item.kind !== 'system';
  const guide = item.guidance;
  const label = item.kind === 'question' ? 'Rozhodnutí / podklad' : item.kind === 'approval' ? 'Převzetí výsledku' : 'Pouze informace — není to tvůj úkol';
  const url = item.url && /^https?:\/\//i.test(item.url) ? item.url : undefined;
  return h('article.boss-attention-item', { 'data-kind': item.kind }, h('span.boss-attention-tag', {}, label),
    h('h4', {}, item.title), h('p.boss-attention-path', {}, item.path.join(' → ')),
    h('p', {}, item.reason),
    h('p.boss-attention-owner', {}, h('b', {}, 'Odpovědnost: '), guide?.owner ?? (human ? 'Ty' : 'Orchestrátor / agenti')),
    h('p', {}, h('b', {}, 'Stav: '), guide?.activity ?? 'Aktivní řešení nebylo ověřeno.'),
    h('p.boss-attention-action', {}, human ? item.action : 'Tvoje akce nyní: žádná. Tuto položku nepotvrzuj.'),
    !human && guide?.agentNext ? h('p', {}, h('b', {}, 'Další krok orchestrátora: '), guide.agentNext) : null,
    guide?.blockers.length ? h('div.boss-attention-blockers', {}, h('b', {}, 'Co brání převzetí'), h('ul', {}, ...guide.blockers.map((text) => h('li', {}, text)))) : null,
    human ? h('div.boss-attention-guide', {}, h('h5', {}, 'Co mám udělat — krok za krokem'),
      h('ol', {}, ...(guide?.steps.length ? guide.steps : ['Podrobný postup se nepodařilo načíst. Otevři kartu a ověř aktuální požadavek; nepovažuj samotné otevření za jeho vyřešení.']).map((step) => h('li', {}, step)))) : null,
    guide ? h('p.boss-attention-result', {}, h('b', {}, 'Co se stane potom: '), guide.expected) : null,
    url ? h('a.btn', { href: url, target: '_blank', rel: 'noopener noreferrer', 'data-attention-key': item.id },
      guide?.linkLabel ?? (human ? 'Otevřít kartu v Opoře' : 'Zobrazit stav karty (jen informace)')) :
      h('p.muted', {}, 'Přímý odkaz nelze bezpečně sestavit. Obnov načtení; původní kartu nehledej podle neověřeného odkazu.'));
}

export function workerCard(worker: WorkerInfo, answer: () => void): HTMLElement {
  const steps = [
    'Otevři terminál tlačítkem níže a přečti aktuální otázku; zkrácená zpráva zde nemusí obsahovat celý kontext.',
    'Odpověď napiš a odešli v terminálu. U žádosti o oprávnění nejdřív zkontroluj konkrétní příkaz a dopad; nic nepotvrzuj naslepo.',
    'Ověř, že worker odpověď přijal a pokračuje nebo položil upřesňující otázku. Pouhé otevření terminálu požadavek neřeší.',
  ];
  return h('article.boss-attention-item', { 'data-kind': 'worker' }, h('span.boss-attention-tag', {}, 'Odpověď workerovi'),
    h('h4', {}, worker.name), h('p', {}, alertDetail(worker) || 'Worker čeká na vstup. Přesný dotaz je v terminálu.'),
    h('p', {}, h('b', {}, 'Odpovědnost: '), 'Ty — odpověď nebo rozhodnutí o oprávnění'),
    h('div.boss-attention-guide', {}, h('h5', {}, 'Co mám udělat — krok za krokem'), h('ol', {}, ...steps.map((s) => h('li', {}, s)))),
    h('p.boss-attention-result', {}, h('b', {}, 'Co se stane potom: '), 'Položka zmizí, až worker přestane hlásit čekání na vstup. Přetrvávající dotaz znamená, že ještě potřebuje odpověď.'),
    h('button.btn', { type: 'button', 'data-attention-key': worker.id, onclick: answer }, 'Otevřít terminál a odpovědět'));
}
