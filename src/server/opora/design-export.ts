// The web's design system for a ticket (OPORA's site admin): a ticket on a web domain carries
// `machine.design = {revision, export}`, and `GET {export}` under the ticket's gate session answers a zip of
// `design/` (tokens.css, tokens.json, components.css, README.md, fonts/, assets/) with `X-Design-Revision`.
// The office unpacks it into the worker's worktree as `design/`, read-only and kept out of git; without it
// the work goes on, it only isn't told about design/.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** The ticket's `machine.design`. */
export interface DesignRef { revision: string; export: string }
/** The export's files: their zip names (`design/...`) and bytes. */
export type DesignFiles = [string, Uint8Array][];

/** Only OPORA's own export path: the gate token never goes anywhere else. */
const EXPORT = '/api/site-admin/export?';
const MAX_FILE = 64 * 1024 * 1024;

export function designOf(value: unknown): { design?: DesignRef } {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || typeof v.export !== 'string' || !v.export.startsWith(EXPORT)) return {};
  return { design: { revision: typeof v.revision === 'number' || typeof v.revision === 'string' ? String(v.revision) : '', export: v.export } };
}

/** The files of a zip (stored or deflated, no zip64), skipping folders; throws on what isn't one. */
export function unzip(zip: Uint8Array): DesignFiles {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip');
  const out: DesignFiles = [];
  for (let i = 0, at = buf.readUInt32LE(end + 16), count = buf.readUInt16LE(end + 10); i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), local = buf.readUInt32LE(at + 42), nameLength = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`zip method ${method} in ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), raw = buf.subarray(start, start + size);
    out.push([name, method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_FILE }) : raw]);
  }
  return out;
}

/** A name that stays inside `design/`: no `..`, no empty part, no drive or backslash. */
const inside = (name: string) => name.startsWith('design/') && !/[\\:]/.test(name) && name.slice(7).split('/').every(p => p && p !== '.' && p !== '..');

/** The ticket's export, downloaded and checked; undefined (said in the log) when it can't be had. */
export async function fetchDesign(ref: DesignRef, get: (file: string) => Promise<{ bytes: Uint8Array; headers: Headers }>, log: (m: string) => void): Promise<DesignFiles | undefined> {
  try {
    const { bytes, headers } = await get(ref.export);
    const revision = headers.get('x-design-revision');
    if (revision !== ref.revision) log(`design export is revision ${revision ?? '(none)'}, the ticket names ${ref.revision || '(none)'}; using it anyway`);
    const files = unzip(bytes);
    const bad = files.find(([name]) => !inside(name));
    if (bad) throw new Error(`file outside design/ in the zip: ${bad[0].slice(0, 120)}`);
    return files;
  } catch (error) {
    log(`design export couldn't be had, the worker goes without design/: ${(error as Error).message}`);
    return undefined;
  }
}

/** `design/` in the worktree replaced by the export's files (read-only), and `/design/` in git's exclude. */
export function installDesign(worktree: string, files: DesignFiles) {
  const dir = path.join(worktree, 'design');
  // The earlier export's files are read-only: writable again, so they can go.
  if (existsSync(dir)) for (const f of readdirSync(dir, { recursive: true })) chmodSync(path.join(dir, String(f)), 0o777);
  rmSync(dir, { recursive: true, force: true });
  for (const [name, data] of files) {
    const target = path.join(worktree, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: 0o444 });
  }
  // A linked worktree's info/exclude is the repository's shared one; `--git-path` finds it either way.
  const exclude = path.resolve(worktree, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: worktree, encoding: 'utf8', timeout: 5000 }).trim());
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('/design/')) {
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/design/\n`);
  }
}

/** The worker's line about design/, when the export is there. */
export const DESIGN_LINE = 'Design systém webu je v `design/` (tokens.css, components.css, README.md). Hodnoty barev, písem a rozměrů ber jen z tokenů, design/ needituj.\n';
