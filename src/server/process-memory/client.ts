import http from 'node:http';
import type { MemoryStatus, MemoryRecall } from '../../shared/process-memory.js';

const LIMIT = 512 * 1024;
/** Fixed server configuration only. Browser inputs can never choose a host, path or key. */
export function oporaBase(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Opora musí mít HTTP adresu na loopbacku bez cesty a přihlášení.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}
export function readOpora(base: URL, path: '/api/memory/status' | '/api/memory/roles' | '/api/memory/recall', payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(new URL(path, base), { method: data ? 'POST' : 'GET', headers: { accept: 'application/json', ...(data ? { origin: base.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Opora odpověděla HTTP ${res.statusCode}.`)); return; }
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) req.destroy(new Error('Odpověď Opory je příliš velká.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { if (size > LIMIT) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Opora nevrátila platná data.')); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('Opora neodpověděla v časovém limitu.')), data ? 35000 : 7000);
    req.on('close', () => clearTimeout(timer)); req.on('error', () => reject(new Error('Paměťové API Opory není dostupné.')));
    req.end(data);
  });
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Neplatný kontrakt paměti Opory.');
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 1000) => typeof v === 'string' ? v.slice(0, max) : '';
export function memoryStatus(raw: unknown, registry: unknown): MemoryStatus {
  const s = object(raw), r = object(registry);
  if (!['configured', 'disabled', 'unavailable', 'needs_provisioning'].includes(String(s.status)) || !Array.isArray(r.roles)) throw new Error('Neplatný stav paměti Opory.');
  return { status: s.status as MemoryStatus['status'], reason: text(s.reason), checkedAt: Date.now(),
    roles: r.roles.slice(0, 64).map(value => { const role = object(value); return { id: text(role.id, 128), label: text(role.label, 120), description: text(role.description) }; }),
    missingRoles: Array.isArray(s.missingRoles) ? s.missingRoles.slice(0, 64).map(v => text(v, 128)) : [] };
}
export function recallPayload(raw: unknown) {
  const p = object(raw);
  if (Object.keys(p).sort().join(',') !== 'project,query,role' || typeof p.role !== 'string' || !/^role-[a-z0-9-]{1,80}$/.test(p.role)
    || typeof p.query !== 'string' || !p.query.trim() || p.query.length > 2000
    || typeof p.project !== 'string' || (p.project && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(p.project))) throw new Error('Vyberte roli, dotaz do 2000 znaků a případně přesné ID projektu Opory.');
  return { role: p.role, project: p.project || null, query: p.query.trim(), workspace: null, nodeId: null, maxTokens: 2000 };
}
export function memoryRecall(raw: unknown, role: string): MemoryRecall {
  const r = object(raw);
  if (!['configured', 'disabled', 'unavailable', 'skipped'].includes(String(r.status)) || !Array.isArray(r.items)) throw new Error('Neplatná odpověď vybavení paměti.');
  let remaining = 16000;
  const items = r.items.slice(0, 20).map(value => {
    const item = object(value), body = text(item.text, Math.min(remaining, 8000)); remaining -= body.length;
    return { uri: text(item.uri, 1000), text: body, origin: text(item.origin, 100), score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0 };
  });
  return { status: String(r.status), reason: text(r.reason), role, truncated: r.truncated === true || remaining === 0 || r.items.length > 20, items };
}
