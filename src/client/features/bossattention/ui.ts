import './ui.css';
import type { BossAttentionItem } from '../../../shared/boss-attention';
import { alertDetail } from '../../../shared/status';
import { needingYou } from '../../nextup';
import { store } from '../../state';
import { h, openModal } from '../../ui/dom';
import type { AttentionController } from './controller';

export function openBossAttention(controller: AttentionController, answerWorker: (id: string) => void) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Zavřít tabuli' }, '✕');
  const refresh = h('button.btn', { type: 'button', onclick: () => void controller.refresh() }, '↻ Obnovit');
  const content = h('div.boss-attention-content');
  const status = h('p.boss-attention-status', { role: 'status', 'aria-live': 'polite' });
  const el = h('div.modal.boss-attention', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Boss Office — Pro tebe' },
    h('header', {}, h('h2', {}, 'Boss Office — Pro tebe'), close),
    h('div.boss-attention-toolbar', {}, status, refresh), content);
  const modal = openModal(el, { doing: 'u tabule Pro tebe', onClose: () => { offs.forEach((off) => off()); } });
  close.onclick = () => modal.close();
  const render = () => {
    const focus = (document.activeElement as HTMLElement | null)?.dataset.attentionKey;
    const { data, loading, error } = controller.view;
    refresh.disabled = loading;
    status.textContent = [data?.project?.name, data?.workspace?.label,
      loading ? 'Načítám…' : data ? `Ověřeno ${new Date(data.checkedAt).toLocaleTimeString('cs-CZ')}` : 'Stav neověřen'].filter(Boolean).join(' · ');
    const workers = needingYou(store.workers.values());
    const cards = data?.items ?? [];
    const human = h('section', {}, h('h3', {}, `Vyžaduje tvůj zásah (${cards.length + workers.length})`),
      h('p.muted', {}, 'Celý propojený pracovní prostor a workeři tohoto patra. Přepínače zaměření tento seznam neskrývají.'));
    for (const worker of workers) human.append(h('article.boss-attention-item', {},
      h('span.boss-attention-tag', {}, 'Odpověď workerovi'), h('h4', {}, worker.name),
      h('p', {}, alertDetail(worker) || 'Worker čeká na vstup. Přesný dotaz nebo žádost o oprávnění najdeš v terminálu.'),
      h('p.boss-attention-action', {}, 'Přečti dotaz v terminálu a odpověz; oprávnění potvrzuj jen po kontrole požadované akce.'),
      h('button.btn', { type: 'button', 'data-attention-key': worker.id, onclick: () => { modal.close(); answerWorker(worker.id); } }, 'Otevřít terminál')));
    for (const item of cards) human.append(itemCard(item));
    if (!cards.length && !workers.length) human.append(h('p.boss-attention-empty', {},
      error || data?.error ? 'Nelze potvrdit, že nemáš žádné požadavky. Obnov načtení.' : loading ? 'Čekám na ověření požadavků…' : 'Teď není vyžadován tvůj zásah.'));
    const system = h('section.boss-attention-system', {}, h('h3', {}, `K dořešení systémem / agentem (${data?.system.length ?? 0})`),
      h('p.muted', {}, 'Tyto položky nejsou žádost o tvoje schválení. Tabule sama nespouští opravy ani agenty.'),
      ...(data?.system.map(itemCard) ?? []));
    content.replaceChildren(...(error || data?.error ? [h('p.boss-attention-error', { role: 'alert' }, error || data?.error)] : []), human, system);
    if (focus) ([...content.querySelectorAll<HTMLElement>('[data-attention-key]')].find((node) => node.dataset.attentionKey === focus) ?? close).focus({ preventScroll: true });
  };
  const offs = [controller.onChange(render), store.on('workers', render)];
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
    const i = controls.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    controls[(i + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
  });
  render();
  close.focus();
  void controller.refresh();
}

function itemCard(item: BossAttentionItem): HTMLElement {
  const label = item.kind === 'question' ? 'Rozhodnutí / podklad' : item.kind === 'approval' ? 'Kontrola dokončení' : 'Systém / agent';
  // Link schemes are still checked here even though the server builds links from its configured URL.
  const url = item.url && /^https?:\/\//i.test(item.url) ? item.url : undefined;
  return h('article.boss-attention-item', {}, h('span.boss-attention-tag', {}, label),
    h('h4', {}, item.title), h('p.boss-attention-path', {}, item.path.join(' → ')),
    h('p', {}, item.reason), h('p.boss-attention-action', {}, item.action),
    url ? h('a.btn', { href: url, target: '_blank', rel: 'noopener noreferrer', 'data-attention-key': item.id }, 'Otevřít v Opoře ↗') : null);
}
