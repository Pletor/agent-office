import { h } from '../../ui/dom';
import type { MemoryStatus, MemoryRecall } from '../../../shared/process-memory';

const LABELS: Record<MemoryStatus['status'], string> = { configured: 'Připojeno', disabled: 'V Opoře vypnuto', unavailable: 'Nedostupné', needs_provisioning: 'Chybí klíče rolí', not_configured: 'Nenastaveno' };
/** Only mounted while the user inspects memory; poll status without disturbing form or results. */
export class MemoryPane {
  readonly root = h('div.process-memory');
  private status = h('div.pw-notice', {}, 'Ověřuji Oporu a OpenViking…');
  private role = h('select', { 'aria-label': 'Role paměti' });
  private query = h('input', { 'aria-label': 'Dotaz do paměti', placeholder: 'Např. obnova spojení, chyby a ověřené opravy', maxlength: 2000, required: true });
  private project = h('input', { 'aria-label': 'ID projektu Opory', placeholder: 'ID projektu Opory (volitelné)', maxlength: 128 });
  private results = h('div.process-memory-results', { 'aria-live': 'polite' });
  private submit = h('button', { type: 'submit' }, 'Vyhledat skutečnou paměť →');
  private request = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private roleSignature = '';
  private searching = false;
  private configured = false;
  constructor(private report: (label: string, ok: boolean) => void) {
    const form = h('form.process-memory-form', { onsubmit: e => { e.preventDefault(); void this.recall(); } },
      h('label', {}, 'Role agenta', this.role), h('label', {}, 'Hledaný kontext', this.query),
      h('label', {}, 'Projekt · přesné ID, nikoli název repozitáře', this.project), this.submit);
    this.root.append(this.status,
      h('p', {}, 'agent-office → Opora Control Center → OpenViking → zdrojové vzpomínky'),
      h('p.pw-notice', {}, 'Čtení paměti rolí. Klíče zůstávají v Opoře. Vyhledání není zápis, trénování modelu ani důkaz zlepšení agenta.'), form, this.results,
      h('a', { href: 'https://github.com/volcengine/OpenViking', target: '_blank', rel: 'noopener noreferrer' }, 'Repozitář OpenViking ↗'));
    this.submit.disabled = true;
    void this.refresh();
  }
  destroy() { this.stopped = true; clearTimeout(this.timer); this.request.abort(); }
  private async refresh() {
    try {
      const response = await fetch('/api/process-memory', { signal: this.request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 403 ? 'Paměť Opory může číst správce kanceláře.' : 'Spojení s kanceláří není dostupné.');
      const s: MemoryStatus = await response.json();
      if (this.stopped) return;
      this.configured = s.status === 'configured';
      this.status.textContent = `${LABELS[s.status]} · ${s.reason} · ověřeno ${new Date(s.checkedAt).toLocaleTimeString('cs-CZ')}${s.missingRoles.length ? ' · chybí: ' + s.missingRoles.join(', ') : ''}`;
      this.report(LABELS[s.status], this.configured);
      const signature = JSON.stringify(s.roles);
      if (signature !== this.roleSignature) {
        const selected = this.role.value;
        this.role.replaceChildren(...s.roles.map(role => h('option', { value: role.id, title: role.description }, role.label)));
        if (s.roles.some(role => role.id === selected)) this.role.value = selected;
        this.roleSignature = signature;
      }
    } catch (error) {
      if (this.stopped) return;
      this.configured = false; this.status.textContent = error instanceof Error ? error.message : 'Paměť není dostupná.'; this.report('nedostupné', false);
    } finally {
      if (!this.stopped) { this.submit.disabled = !this.configured || this.searching; this.timer = setTimeout(() => void this.refresh(), 15000); }
    }
  }
  private async recall() {
    if (!this.configured || this.searching) return;
    this.searching = true; this.submit.disabled = true;
    const query = this.query.value, role = this.role.value, project = this.project.value.trim();
    this.results.replaceChildren(h('p', {}, 'Vyhledávám v paměti zvolené role…'));
    try {
      const response = await fetch('/api/process-memory/recall', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: this.request.signal, body: JSON.stringify({ role, query, project }) });
      if (!response.ok) throw new Error('Vyhledání se nepodařilo. Zkontrolujte stav paměti, roli a ID projektu.');
      const result: MemoryRecall = await response.json();
      if (this.stopped) return;
      this.results.replaceChildren(h('p', {}, `Dotaz: ${query} · role: ${role} · ${project || 'paměť role napříč projekty'}`));
      if (result.status !== 'configured') { this.results.append(h('p', {}, result.reason || 'Paměť není dostupná.')); return; }
      this.results.append(h('p', {}, `${result.items.length} skutečných výsledků${result.truncated ? ' · výpis zkrácen' : ''}. Před použitím ověřte jejich relevanci.`));
      for (const item of result.items) this.results.append(h('article.pw-memit', {}, h('code', {}, item.uri), h('p', {}, `Původ: ${item.origin} · skóre vyhledání: ${item.score.toFixed(3)}`), h('p.process-memory-text', {}, item.text)));
    } catch (error) { if (!this.stopped) this.results.replaceChildren(h('p', {}, error instanceof Error ? error.message : 'Paměť není dostupná.')); }
    finally { this.searching = false; this.submit.disabled = !this.configured; }
  }
}
