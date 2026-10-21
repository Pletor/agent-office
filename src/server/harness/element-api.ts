// Creating a harness element from the library (docs/harness.md "Categories and the editor"):
// POST /api/harness/element?floor=ID {category, group?, name, content}.
//
// The library may write one new file, and only inside the project's published folder
// `.harness/<category>/[<group>/]<name>` of the floor's checkout. Administrators and the shared-password
// session only (a named member reads the library; workers have no route here), same-origin only. The
// path is built from checked parts, never taken from the request: a known category, a group and a file
// name of letters, digits, `.`, `_` and `-` (no `..`, no slash), a text type the catalog lists, no
// credential-like name and no folder discovery skips (catalog.ts `unpublishable`, the same rules the
// listing applies). Every folder on the way is checked not to be a link (symlink or junction) and to stay
// inside the checkout, missing folders are created one at a time, and the file is created exclusively
// (O_EXCL, and O_NOFOLLOW where the OS has it): an existing file is never overwritten (409). Content is
// text up to 128 KiB. Each creation is audited in `<dataDir>/harness-elements.json` (the newest 200), and
// the reply carries the element as a fresh listing of the catalog sees it (its ID, revision and digest).
import type http from 'node:http';
import { lstat, mkdir, open, realpath, rename, writeFile } from 'node:fs/promises';
import { constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_CATEGORIES, type HarnessCategory, type HarnessEntry } from '../../shared/harness.js';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import type { Route } from '../http/router.js';
import { readBody, sameOrigin, send } from '../http/util.js';
import { floorParam } from '../http/routes/files.js';
import { HarnessError, harnessRepoKey } from './profiles.js';
import { HarnessLibrary, HARNESS_MAX_BYTES, elementId, harnessSources, unpublishable } from './catalog.js';
import { HarnessRegistry } from './registry.js';

/** A folder or file name the route accepts: letters, digits, `.`, `_`, `-`, starting with a letter or digit. */
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GROUP_MAX = 64, NAME_MAX = 100;
/** Names Windows reserves for devices, whatever the extension. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const AUDIT_KEEP = 200;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

export interface ElementRequest { category: HarnessCategory; group: string; name: string; content: string }
export interface ElementAudit { at: string; by: string; floor: string; repo: string; path: string; id: string; bytes: number }

function part(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value) throw new HarnessError(`Give the ${what}.`);
  if (value.length > max || !PART.test(value) || value.includes('..') || DEVICE.test(value) || /[. ]$/.test(value)) {
    throw new HarnessError(`The ${what} "${value.slice(0, 120)}" is not allowed: use up to ${max} letters, digits, ".", "_" or "-", starting with a letter or digit, without "..", slashes or a trailing dot.`);
  }
  return value;
}

/** The request as checked parts, or a 400 (413 for content past the size limit) that says what to change. */
export function parseElementRequest(body: unknown): ElementRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HarnessError('Expected a JSON object {category, group, name, content}.');
  const b = body as Record<string, unknown>;
  if (typeof b.category !== 'string' || !(HARNESS_CATEGORIES as readonly string[]).includes(b.category)) throw new HarnessError('Choose one of the categories: ' + HARNESS_CATEGORIES.join(', ') + '.');
  const category = b.category as HarnessCategory;
  const group = b.group === undefined || b.group === '' ? '' : part(b.group, 'group folder', GROUP_MAX);
  const name = part(b.name, 'file name', NAME_MAX);
  const rel = [category, group, name].filter(Boolean).join('/');
  const why = unpublishable(rel);
  if (why) throw new HarnessError(`.harness/${rel} would not be listed: ${why}.`);
  if (typeof b.content !== 'string' || !b.content.trim()) throw new HarnessError('Write the content of the element.');
  if (b.content.includes('\0')) throw new HarnessError('The content must be text (it holds a NUL byte).');
  const bytes = Buffer.byteLength(b.content);
  if (bytes > HARNESS_MAX_BYTES) throw new HarnessError(`The content is ${Math.ceil(bytes / 1024)} KiB; an element may be at most ${HARNESS_MAX_BYTES / 1024} KiB.`, 413);
  return { category, group, name, content: b.content };
}

const same = (a: string, b: string) => (CASELESS ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

/**
 * One folder of the way down: it must be a real folder (not a link, not a file) whose real path is exactly
 * `<real parent>/<name>`; a missing one is created (one level, never recursively) and checked the same way.
 */
async function folder(parent: string, name: string): Promise<string> {
  const at = path.join(parent, name);
  let stat = await lstat(at).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return undefined; throw err; });
  if (!stat) {
    await mkdir(at).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
    stat = await lstat(at);
  }
  if (stat.isSymbolicLink()) throw new HarnessError(`${name}/ is a link: the library never writes through a link. Replace it with a real folder.`);
  if (!stat.isDirectory()) throw new HarnessError(`${name} is not a folder.`);
  const real = await realpath(at);
  if (!same(real, path.join(parent, name))) throw new HarnessError(`${name}/ resolves somewhere else: the library writes only inside the project's .harness folder.`);
  return real;
}

/** Writes the new file under the checkout's `.harness/`, exclusively; returns its path relative to `.harness/`. */
export async function createElementFile(checkout: string, request: ElementRequest): Promise<string> {
  const project = await realpath(checkout).catch(() => { throw new HarnessError('The floor\'s checkout is not available.', 503); });
  let at = project;
  for (const name of ['.harness', request.category, ...(request.group ? [request.group] : [])]) at = await folder(at, name);
  if (!inside(project, at)) throw new HarnessError('The target folder is outside the project.');
  const file = path.join(at, request.name);
  let handle;
  try { handle = await open(file, CREATE_FLAGS, 0o644); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new HarnessError(`.harness/${[request.category, request.group, request.name].filter(Boolean).join('/')} already exists: the library never overwrites a file. Choose another name, or edit the file in the repository.`, 409);
    if (code === 'ELOOP') throw new HarnessError('That name is a link: the library never writes through a link.');
    throw err;
  }
  try { await handle.writeFile(request.content, 'utf8'); } finally { await handle.close(); }
  return [request.category, request.group, request.name].filter(Boolean).join('/');
}

/** The newest creations, oldest dropped first; a damaged file is replaced only by a new creation, never read as entries. */
function readAudit(file: string): ElementAudit[] {
  if (!existsSync(file)) return [];
  try { const data = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(data.audit) ? data.audit : []; } catch { return []; }
}
async function audit(dataDir: string, entry: ElementAudit) {
  const file = path.join(dataDir, 'harness-elements.json');
  const next = [...readAudit(file).slice(-(AUDIT_KEEP - 1)), entry];
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await writeFile(temp, JSON.stringify({ version: 1, audit: next }, null, 2));
  await rename(temp, file);
}

/** POST: creates the element and answers 201 with it as listed now. */
export async function harnessElementRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, writable: boolean, by: string) {
  try {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    if (!writable) return send(res, 403, { error: 'Only administrators (or the shared-password session) can create harness elements. Ask one to add it, or publish the file under .harness/ in the repository.' });
    let raw: string;
    try { raw = await readBody(req, 1024 * 1024); } catch { throw new HarnessError(`The request is too large; an element may be at most ${HARNESS_MAX_BYTES / 1024} KiB.`, 413); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new HarnessError('Expected a JSON object {category, group, name, content}.'); }
    const request = parseElementRequest(body);
    const rel = await createElementFile(floor.dir, request);
    const { id } = elementId({ name: 'Project / .harness', dir: '', ns: 'project', prefix: '.harness' }, rel);
    // The catalog is walked again, so the reply (and the next listing) carry the new element's revision and digest.
    const library = new HarnessLibrary(harnessSources(floor.dir, writable), new HarnessRegistry(ctx.cfg.dataDir));
    const catalog = await library.list();
    const found = library.resolve(id);
    const entry: HarnessEntry | undefined = found.status === 'available' ? found.entry : undefined;
    try { await audit(ctx.cfg.dataDir, { at: new Date().toISOString(), by: by.slice(0, 120), floor: floor.id, repo: harnessRepoKey(floor.dir), path: '.harness/' + rel, id, bytes: Buffer.byteLength(request.content) }); }
    catch (err) { console.error('harness: the element audit was not written: ' + (err as Error).message); }
    const warning = entry ? '' : catalog.limited ? 'Created, but the catalog is truncated at its limit, so the element is not listed: narrow the published folders.' : 'Created, but the element is not listed yet: refresh the library.';
    send(res, 201, { id, path: '.harness/' + rel, entry: entry ?? null, warning });
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message });
  }
}

/** The browser route: administrators and the shared-password session, same-origin only. */
export const harnessElementRoute: Route = {
  path: '/api/harness/element', auth: 'session',
  handle(ctx, { req, res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    if (req.method === 'POST' && !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
    const admin = !session.account || session.account.role === 'admin';
    return harnessElementRequest(ctx, floor, req, res, admin, session.account ? 'account:' + session.account.id : 'shared-password');
  },
};
