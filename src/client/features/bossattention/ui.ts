import './ui.css';
import { needingYou } from '../../nextup';
import { store } from '../../state';
import { h, openModal } from '../../ui/dom';
import type { AttentionController } from './controller';
import { itemCard, workerCard } from './card';
import { pausedCard, pausedWorkers } from './pause';

export function openBossAttention(controller: AttentionController, answerWorker: (id: string) => void) {
  let tab: 'human' | 'system' = 'human';
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Zavřít tabuli' }, '✕');
  const refresh = h('button.btn', { type: 'button', onclick: () => void controller.refresh() }, '↻ Obnovit');
  const content = h('div.boss-attention-content');
  const status = h('p.boss-attention-status', { role: 'status', 'aria-live': 'polite' });
  const mine = h('button.btn', { type: 'button', role: 'tab', id: 'boss-mine-tab', 'aria-controls': 'boss-attention-panel', onclick: () => { tab = 'human'; render(); } });
  const agents = h('button.btn', { type: 'button', role: 'tab', id: 'boss-agents-tab', 'aria-controls': 'boss-attention-panel', onclick: () => { tab = 'system'; render(); } });
  for (const button of [mine, agents]) button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    tab = event.key === 'Home' ? 'human' : event.key === 'End' ? 'system' : tab === 'human' ? 'system' : 'human';
    render(); (tab === 'human' ? mine : agents).focus();
  });
  content.id = 'boss-attention-panel';
  content.setAttribute('role', 'tabpanel');
  const el = h('div.modal.boss-attention', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Boss Office — Pro tebe' },
    h('header', {}, h('h2', {}, 'Boss Office — Pro tebe'), close),
    h('div.boss-attention-toolbar', {}, status, refresh), h('div.boss-attention-tabs', { role: 'tablist', 'aria-label': 'Druh požadavků' }, mine, agents), content);
  const modal = openModal(el, { doing: 'u tabule Pro tebe', onClose: () => { offs.forEach((off) => off()); } });
  close.onclick = () => modal.close();
  const render = () => {
    const focus = (document.activeElement as HTMLElement | null)?.dataset.attentionKey;
    const { data, loading, error } = controller.view;
    refresh.disabled = loading;
    status.textContent = [data?.project?.name, data?.workspace?.label,
      loading ? 'Načítám…' : data ? `Načteno ${new Date(data.checkedAt).toLocaleTimeString('cs-CZ')}` : 'Stav neověřen'].filter(Boolean).join(' · ');
    const workers = needingYou(store.workers.values());
    const cards = data?.items ?? [];
    const paused = pausedWorkers(store.workers.values());
    mine.textContent = `Moje úkoly (${cards.length + workers.length})`;
    agents.textContent = `Stav agentů (${(data?.system.length ?? 0) + paused.length})`;
    mine.setAttribute('aria-selected', String(tab === 'human'));
    agents.setAttribute('aria-selected', String(tab === 'system'));
    content.setAttribute('aria-labelledby', tab === 'human' ? mine.id : agents.id);
    const human = h('section', {}, h('h3', {}, `Vyžaduje tvůj zásah (${cards.length + workers.length})`),
      h('p.muted', {}, 'Celý propojený pracovní prostor a workeři tohoto patra. Přepínače zaměření tento seznam neskrývají.'));
    for (const worker of workers) human.append(workerCard(worker, () => { modal.close(); answerWorker(worker.id); }));
    for (const item of cards) human.append(itemCard(item));
    if (!cards.length && !workers.length) human.append(h('p.boss-attention-empty', {},
      error || data?.error ? 'Nelze potvrdit, že nemáš žádné požadavky. Obnov načtení.' : loading ? 'Čekám na ověření požadavků…' : 'Teď není vyžadován tvůj zásah.'));
    if (!cards.length && !workers.length && data?.system.length) human.append(h('p', {}, 'Informace o nedokončené práci najdeš v záložce „Stav agentů“. Nejsou to tvoje úkoly k potvrzení.'));
    const system = h('section.boss-attention-system', {}, h('h3', {}, 'Stav agentů — pouze informace'),
      h('p.muted', {}, 'Tady nemáš nic potvrzovat. Tabule sama nezadává opravu ani nespouští agenty; aktivní běh uvádí jen podle údajů mostu.'),
      ...paused.map((w) => pausedCard(w, () => { modal.close(); answerWorker(w.id); })), ...(data?.system.map(itemCard) ?? []));
    if (!data?.system.length && !paused.length) system.append(h('p.muted', {}, loading ? 'Načítám stav…' : error || data?.error ? 'Stav agentů se nepodařilo ověřit.' : 'Nejsou hlášeny problémy systému.'));
    content.replaceChildren(...(error || data?.error ? [h('p.boss-attention-error', { role: 'alert' }, error || data?.error)] : []), tab === 'human' ? human : system);
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
