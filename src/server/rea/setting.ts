// 🔬 Which workers get REA's MCP server (⚙️ Settings, or AGENT_OFFICE_REA), and the package they run.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REA_MODES, type ReaMode, type ReaState } from '../../shared/protocol.js';

/**
 * REA (Reverse Engineer Anything, https://github.com/morluto/rea), pinned: the office never runs
 * whatever npm calls latest. AGENT_OFFICE_REA_PACKAGE can move the pin for an upgrade, but only to
 * another exact version of the same package (see reaPackage).
 */
export const REA_PACKAGE = 'rea-agents@6.7.0';
/** The only thing AGENT_OFFICE_REA_PACKAGE may be: rea-agents at an exact version, never a range, a tag or a lookalike. */
const PINNED = /^rea-agents@\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function isReaMode(value: unknown): value is ReaMode {
  return typeof value === 'string' && (REA_MODES as readonly string[]).includes(value);
}

const warned = new Set<string>();
function warnOnce(text: string) {
  if (warned.has(text)) return;
  warned.add(text);
  console.warn(text);
}

/** The package workers run: REA_PACKAGE, or AGENT_OFFICE_REA_PACKAGE when it pins another version of it. */
export function reaPackage(env: NodeJS.ProcessEnv = process.env): string {
  const want = env.AGENT_OFFICE_REA_PACKAGE?.trim();
  if (!want) return REA_PACKAGE;
  if (PINNED.test(want)) return want;
  warnOnce(`AGENT_OFFICE_REA_PACKAGE=${JSON.stringify(want)} isn't rea-agents@<exact version>: running ${REA_PACKAGE}`);
  return REA_PACKAGE;
}

/** AGENT_OFFICE_REA, when it says off, opora or all: it wins over ⚙️ Settings. */
export function reaEnvMode(env: NodeJS.ProcessEnv = process.env): ReaMode | undefined {
  const raw = env.AGENT_OFFICE_REA?.trim().toLowerCase();
  if (!raw) return undefined;
  if (isReaMode(raw)) return raw;
  warnOnce(`AGENT_OFFICE_REA=${JSON.stringify(raw)} isn't off, opora or all: it's ignored`);
  return undefined;
}

/**
 * What an admin picked in ⚙️ Settings, kept in .agent-office/rea.json and the same on every floor.
 * Off until someone turns it on.
 */
export class ReaSetting {
  private saved?: { mode: ReaMode; by: string; at: number };
  private file: string;

  constructor(
    dataDir: string,
    private onState: (state: ReaState) => void = () => undefined,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = path.join(dataDir, 'rea.json');
    this.restore();
  }

  get mode(): ReaMode {
    return reaEnvMode(this.env) ?? this.saved?.mode ?? 'off';
  }

  state(): ReaState {
    const env = reaEnvMode(this.env);
    return { mode: this.mode, ...(env ? { env } : {}), package: reaPackage(this.env), ...(this.saved ? { by: this.saved.by, at: this.saved.at } : {}) };
  }

  /** Picks the mode. Says why it can't, when AGENT_OFFICE_REA has it. */
  set(mode: ReaMode, by: string): string | undefined {
    const env = reaEnvMode(this.env);
    if (env) return `AGENT_OFFICE_REA=${env} sets it for this office: change that and restart to pick another`;
    this.saved = { mode, by, at: Date.now() };
    this.persist();
    this.onState(this.state());
    return undefined;
  }

  private restore() {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as { mode?: unknown; by?: unknown; at?: unknown };
      if (isReaMode(s.mode)) this.saved = { mode: s.mode, by: typeof s.by === 'string' ? s.by : 'someone', at: typeof s.at === 'number' ? s.at : 0 };
    } catch {
      // never set: off
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved ?? {}, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
