import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selfCheckCommands } from './self-checks.js';

/**
 * A floor's own checks. `AGENT_OFFICE_OPORA_SELF_CHECKS` and `AGENT_OFFICE_OPORA_CHECK_COMMAND` are
 * process-wide, but each floor is a different project with its own tests and build, so a floor can
 * name its own in `opora-checks.json` in its data dir (`.agent-office/`, beside `opora.json`):
 *
 *   {"selfChecks": {"tests": "npm test", "build": "npm run build"}, "checkCommand": "npm test"}
 *
 * `selfChecks` takes what the env var takes (a JSON object, or `name=command` lines as one string);
 * `{}` or `""` turns them off on this floor. `checkCommand` is the shell line, `""` off. A key left
 * out keeps the env var's value. A file that can't be read or isn't that shape is ignored, with one
 * log line, and the env vars apply.
 */
export const FLOOR_CHECKS_FILE = 'opora-checks.json';

const SELF_CHECKS = 'AGENT_OFFICE_OPORA_SELF_CHECKS';
const CHECK_COMMAND = 'AGENT_OFFICE_OPORA_CHECK_COMMAND';
const MAX_COMMAND = 1000;

type Log = (message: string, level: 'info' | 'warn') => void;

/** Why `value` isn't a floor checks file, or undefined when it is one. */
function problem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'it is not a JSON object';
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => k !== 'selfChecks' && k !== 'checkCommand');
  if (unknown.length) return `unknown key ${unknown.map((k) => `"${k}"`).join(', ')} (only "selfChecks" and "checkCommand")`;
  const s = v.selfChecks;
  if (s !== undefined) {
    if (typeof s !== 'string' && (!s || typeof s !== 'object' || Array.isArray(s))) return '"selfChecks" is not an object of name: command';
    const raw = typeof s === 'string' ? s.trim() : JSON.stringify(s);
    const wanted = typeof s === 'string' ? raw.split(/\r?\n/).filter((l) => l.trim()).length : Object.keys(s).length;
    if (raw && raw !== '{}' && selfCheckCommands({ [SELF_CHECKS]: raw }).length !== wanted) return '"selfChecks" has a check Canvas would not take (bad name, empty or overlong command)';
  }
  const c = v.checkCommand;
  if (c !== undefined && (typeof c !== 'string' || c.length > MAX_COMMAND)) return '"checkCommand" is not a shell line';
  return undefined;
}

/**
 * The environment the floor's Opora self-checks and PR upkeep read: `env` with the two check settings
 * replaced by the floor's file where it names them. Called once per floor, when its bridge starts.
 */
export function floorCheckEnv(dataDir: string, log: Log, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = path.join(dataDir, FLOOR_CHECKS_FILE);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`🧪 ${file} could not be read (${(e as Error).message}): using the env vars' checks`, 'warn');
    return env;
  }
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    log(`🧪 ${file} is not valid JSON (${(e as Error).message}): using the env vars' checks`, 'warn');
    return env;
  }
  const why = problem(value);
  if (why) {
    log(`🧪 ${file} is ignored, ${why}: using the env vars' checks`, 'warn');
    return env;
  }
  const v = value as { selfChecks?: string | Record<string, string>; checkCommand?: string };
  const out = { ...env };
  const said: string[] = [];
  if (v.selfChecks !== undefined) {
    const raw = typeof v.selfChecks === 'string' ? v.selfChecks.trim() : JSON.stringify(v.selfChecks);
    out[SELF_CHECKS] = raw === '{}' ? '' : raw;
    const names = selfCheckCommands(out).map((c) => c.name);
    said.push(names.length ? `self-checks ${names.join(', ')}` : 'self-checks off');
  }
  if (v.checkCommand !== undefined) {
    out[CHECK_COMMAND] = v.checkCommand.trim();
    said.push(out[CHECK_COMMAND] ? `upkeep check \`${out[CHECK_COMMAND]}\`` : 'upkeep check off');
  }
  if (said.length) log(`🧪 This floor's own checks (${file}): ${said.join('; ')}`, 'info');
  return out;
}
