import './ui.css';
import rules from '../../../../docs/cista-linie.md?raw';
import type { RepoChoice } from '../../../shared/cleanline';
import { h, openModal } from '../../ui/dom';
import { markdownFile } from '../../ui/markdown';
import type { LineController } from './controller';
import { graphTab, healthTab, queueTab, type Act } from './tabs';

type Tab = 'graph' | 'queue' | 'health' | 'rules';
const TABS: [Tab, string][] = [['graph', 'Graf'], ['queue', 'Fronta'], ['health', 'Zdraví'], ['rules', 'Pravidla']];

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function openCleanLine(controller: LineController) {
  let tab: Tab = 'graph';
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Zavřít tabuli' }, '✕');
  const refresh = h('button.btn', { type: 'button', onclick: () => void controller.refresh(true) }, '↻ Obnovit');
  const status = h('p.cl-status', { role: 'status', 'aria-live': 'polite' });
  const repoSwitch = h('div.cl-repos', { role: 'group', 'aria-label': 'Repozitář' });
  const content = h('div.cl-content', { role: 'tabpanel', id: 'cl-panel' });
  const buttons = TABS.map(([id, label]) => h('button.btn', { type: 'button', role: 'tab', id: `cl-tab-${id}`, 'aria-controls': 'cl-panel', onclick: () => { tab = id; render(true); } }, label));
  for (const b of buttons) b.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex(([id]) => id === tab);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    tab = TABS[n][0];
    render(true);
    buttons[n].focus();
  });
  const el = h('div.modal.cleanline', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Čistá linie' },
    h('header', {}, h('h2', {}, 'Čistá linie'), close),
    h('div.cl-toolbar', {}, repoSwitch, status, refresh),
    h('div.cl-tabs', { role: 'tablist', 'aria-label': 'Pohled' }, ...buttons), content);
  const modal = openModal(el, { doing: 'u tabule Čistá linie', onClose: () => off() });
  close.onclick = () => modal.close();
  const floorBody = () => ({ floor: controller.floor, repo: controller.repo });
  const query = () => new URLSearchParams({ floor: controller.floor ?? '', repo: controller.repo });
  const act = (): Act => ({
    canAct: !!controller.view.data?.canAct,
    merge: async (pr) => {
      try {
        await post('/api/cleanline/merge', { ...floorBody(), pr });
        void controller.refresh(true);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
    plan: async () => {
      const res = await fetch(`/api/cleanline/cleanup-plan?${query()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },
    cleanup: async (items) => {
      const r = await post('/api/cleanline/cleanup', { ...floorBody(), items });
      void controller.refresh(true);
      return r;
    },
  });
  const render = (switched = false) => {
    const { data, loading, error } = controller.view;
    refresh.disabled = loading;
    status.textContent = [data ? `${data.repo.remote} ${data.repo.mainSha?.slice(0, 7) ?? '?'}` : '', loading ? 'Načítám…' : data ? `Načteno ${new Date(data.checkedAt).toLocaleTimeString('cs-CZ')}` : '', error ?? ''].filter(Boolean).join(' · ');
    repoSwitch.replaceChildren(...(data?.repos ?? []).map((r) => h('button.btn', { type: 'button', 'aria-pressed': String(r.id === controller.repo), onclick: () => controller.setScope(controller.floor, r.id as RepoChoice) }, r.label)));
    const c = data?.counts;
    buttons.forEach((b, i) => {
      const id = TABS[i][0];
      b.setAttribute('aria-selected', String(id === tab));
      b.textContent = TABS[i][1] + (c && id === 'queue' ? ` (${data!.queue.length})` : c && id === 'health' ? ` (${data!.health.filter((f) => f.level !== 'ok').length})` : '');
    });
    content.setAttribute('aria-labelledby', `cl-tab-${tab}`);
    // A confirm or a cleanup list in progress isn't swept away by a poll.
    if (!switched && content.querySelector('.cl-confirm, .cl-plan, .cl-result, .cl-action-status:not(:empty)')) return;
    if (switched) content.scrollTop = 0;
    if (tab === 'rules') return content.replaceChildren(h('div.cl-rules', {}, markdownFile(rules)));
    if (!data) return content.replaceChildren(h('p.cl-empty', {}, error ?? 'Načítám…'));
    content.replaceChildren(tab === 'graph' ? graphTab(data) : tab === 'queue' ? queueTab(data, act()) : healthTab(data, act()));
  };
  const off = controller.onChange(() => render());
  render(true);
  close.focus();
  void controller.refresh();
}
