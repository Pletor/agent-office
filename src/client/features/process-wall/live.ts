// Whether the wall is live, and how fresh each source is. Pure: the clock comes in as `now`.

import type { ProcessEvent } from '../../../shared/protocol';

/** Workers say they work but the journal has said nothing for this long: treat the feed as down. */
export const SILENT_MS = 5 * 60_000;

export interface Liveness {
  state: 'live' | 'off' | 'sync';
  /** The pill's word. */
  label: string;
  /** Why, when it isn't live (the wall's overlay). */
  reason?: string;
}

export function liveness(i: { up: boolean; synced: boolean; lastAt: number; anyWorking: boolean; now: number }): Liveness {
  if (!i.up) return { state: 'off', label: 'ODPOJENO', reason: 'Spojení se serverem kanceláře ztraceno — poslední známý stav' };
  if (!i.synced) return { state: 'sync', label: 'SYNCHRONIZACE', reason: 'Čekám na žurnál patra' };
  if (i.anyWorking && (!i.lastAt || i.now - i.lastAt > SILENT_MS)) return { state: 'off', label: 'ODPOJENO', reason: 'Pracovníci hlásí práci, ale žádná událost nepřichází — poslední známý stav' };
  return { state: 'live', label: 'ŽIVĚ' };
}

/** "12 s", "3 min", "2 h", "4 d". */
export function ageWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** The wall's age label: "poslední událost před 12 s", or that nothing came yet. */
export function lastEventLabel(lastAt: number, now: number): string {
  return lastAt ? `poslední událost před ${ageWords(now - lastAt)}` : 'zatím bez událostí';
}

export interface SourceHealth {
  name: string;
  tone: 'good' | 'warn' | 'bad' | 'idle';
  text: string;
}

export interface HealthInput {
  up: boolean;
  events: readonly ProcessEvent[];
  opora: { connected: boolean; linked: boolean };
  /** Opora's event stream for the floor, when the server follows one: it, not the polls, says whether Opora is live. */
  stream?: { connected: boolean; lastEventAt?: string };
  github: { fetchedAt: number; error?: string; loading: boolean };
  /** What the memory tab last saw of OpenViking, if it was opened. */
  memory?: { label: string; ok: boolean; at: number };
  now: number;
}

const STALE_GITHUB = 3 * 60_000;

/** Kancelář, Opora, GitHub and OpenViking: connected or not, and the age of what we last heard. */
export function sourceHealth(i: HealthInput): SourceHealth[] {
  const lastOf = (source: ProcessEvent['source']) => {
    for (let k = i.events.length - 1; k >= 0; k--) if (i.events[k].source === source) return Date.parse(i.events[k].at) || 0;
    return 0;
  };
  const age = (at: number) => (at ? `živě · ${ageWords(i.now - at)}` : 'živě · bez událostí');
  const office: SourceHealth = i.up ? { name: 'Kancelář', tone: 'good', text: age(lastOf('office')) } : { name: 'Kancelář', tone: 'bad', text: 'odpojeno' };
  const st = i.stream;
  const oporaAt = Math.max(lastOf('opora'), (st?.lastEventAt && Date.parse(st.lastEventAt)) || 0);
  const opora: SourceHealth = !i.opora.linked ? { name: 'Opora', tone: 'idle', text: 'nepropojeno' }
    : st?.connected ? { name: 'Opora', tone: 'good', text: age(oporaAt) }
    : !i.opora.connected ? { name: 'Opora', tone: 'bad', text: 'odpojeno' }
    // The stream dropped while the polls still answer: Opora is only as fresh as its last poll.
    : st ? { name: 'Opora', tone: 'warn', text: oporaAt ? `stáří ${ageWords(i.now - oporaAt)}` : 'stáří · proud odpojen' }
    : { name: 'Opora', tone: 'good', text: age(lastOf('opora')) };
  const gh = i.github;
  const github: SourceHealth = gh.error ? { name: 'GitHub', tone: 'bad', text: 'chyba' }
    : !gh.fetchedAt ? { name: 'GitHub', tone: 'idle', text: gh.loading ? 'načítá se' : 'bez dat' }
    : { name: 'GitHub', tone: i.now - gh.fetchedAt > STALE_GITHUB ? 'warn' : 'good', text: `${i.now - gh.fetchedAt > STALE_GITHUB ? 'stáří' : 'živě ·'} ${ageWords(i.now - gh.fetchedAt)}` };
  const m = i.memory;
  const memory: SourceHealth = !m ? { name: 'OpenViking', tone: 'idle', text: 'ověřit v Paměti' }
    : { name: 'OpenViking', tone: m.ok ? 'good' : 'bad', text: `${m.label} · ${ageWords(i.now - m.at)}` };
  return [office, opora, github, memory];
}
