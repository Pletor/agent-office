// ⚙️ Settings' Reverse engineering (REA), under Workers: which workers the office hands REA's MCP
// server, for everyone in the building (see server/rea/). Admins pick; AGENT_OFFICE_REA overrides.
import type { Net } from '../net';
import type { ReaMode } from '../../shared/protocol';
import { store } from '../state';
import { h, timeAgo } from './dom';

const LABEL: Record<ReaMode, string> = { off: 'Off', opora: '🧭 Opora workers', all: '🤖 Every worker' };

const SAYS: Record<ReaMode, string> = {
  off: 'No worker gets REA.',
  opora: 'The workers seated for an Opora card (its developers and designers) and the planner planning onto the Opora canvas get REA, to take a reference app apart and lay it out as areas, sectors and cards.',
  all: 'Every worker the office starts gets REA.',
};

/** The setting, made by `frame` from what goes in it; it asks the server for REA's state and is kept up to date until `off`. */
export function reaSetting(net: Net, frame: (body: Node[]) => HTMLElement): { section: HTMLElement; off: () => void } {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': 'Who gets REA' });
  const note = h('p.setting-note');
  const warn = h('p.setting-note');
  const paint = () => {
    const s = store.rea;
    const mode = s?.mode ?? 'off';
    const locked = !store.me.admin || !!s?.env;
    row.replaceChildren(
      ...(['off', 'opora', 'all'] as const).map((m) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(mode === m),
            class: mode === m ? 'on' : '',
            disabled: locked,
            onclick: () => m !== store.rea?.mode && net.send({ t: 'rea.set', mode: m }),
          },
          LABEL[m],
        ),
      ),
    );
    const pkg = s?.package ?? 'rea-agents';
    const who = s?.env ? ` AGENT_OFFICE_REA=${s.env} sets it for this office.` : s?.by ? ` Set by ${s.by}${s.at ? ` ${timeAgo(s.at)}` : ''}.` : '';
    note.textContent = `REA (Reverse Engineer Anything) is an MCP server that lets a worker take apart an app, a website, a binary or an APK and cite the evidence. ${SAYS[mode]} When it's on, Claude Code, Codex and OpenCode workers get it from their next start, as npx -y ${pkg} mcp.${who}${store.me.admin ? '' : ' Admins can change it.'}`;
    warn.textContent = '⚠️ REA runs local tools with the office’s own permissions, and its version is pinned (AGENT_OFFICE_REA_PACKAGE moves the pin; beware lookalike packages). Only analyze software you own or are allowed to reverse-engineer.';
  };
  paint();
  net.send({ t: 'rea.get' });
  const offs = [store.on('rea', paint), store.on('me', paint)];
  return { section: frame([row, note, warn]), off: () => offs.forEach((off) => off()) };
}
