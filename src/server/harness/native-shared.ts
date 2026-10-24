export interface SharedEvidence {
  status: 'eligible' | 'ineligible' | 'unavailable';
  publication: string;
  reason?: string;
  evidenceDigest?: string;
  projects?: number;
  images?: number;
  sources?: { project: string; workspace: string; verificationId: string; reportDigest: string; evidenceDigest: string; image: string }[];
}

export type SharedReader = (publication: string, candidate: { id: string; digest: string }, problem: string) => Promise<SharedEvidence>;

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const ident = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+(?![\s\S])/.test(v);
const unavailable = (publication: string, reason = 'shared-evidence-unavailable'): SharedEvidence => ({ status: 'unavailable', publication, reason });

/** Validate and minimize the native verifier's shared eligibility assessment. */
export function parseSharedEvidence(raw: unknown, publication: string, candidate: { id: string; digest: string }, problem: string): SharedEvidence {
  if (!isObject(raw) || raw.schema !== 'harness.shared-eligibility/1' || raw.authority !== 'native-policy-assessment'
    || raw.publication !== publication || !isObject(raw.candidate) || raw.candidate.id !== candidate.id || raw.candidate.digest !== candidate.digest
    || raw.problem !== problem || typeof raw.eligible !== 'boolean' || !hex(raw.evidenceDigest) || !hex(raw.policyDigest)
    || raw.executionAuthority !== false || raw.promotionAllowed !== false || raw.reservation !== false
    || raw.minimumProjects !== 3 || raw.minimumImages !== 2 || raw.environmentBasis !== 'pinned-node-image-content'
    || !isObject(raw.evidenceBasis) || raw.evidenceBasis.taskOutcomes !== 'selected-kit-association'
    || raw.evidenceBasis.causalBenefitEstablished !== false || raw.evidenceBasis.directObservation !== 'approved-fixture-cases-only'
    || !Array.isArray(raw.reasons) || raw.reasons.length > 16 || !raw.reasons.every((x: unknown) => typeof x === 'string' && x.length <= 120)
    || !Array.isArray(raw.sources) || raw.sources.length > 8
    || !Number.isSafeInteger(raw.verifiedProjects) || raw.verifiedProjects < 0 || !Number.isSafeInteger(raw.verifiedImages) || raw.verifiedImages < 0) throw new Error('Invalid shared evidence');
  const seen = new Set<string>();
  const sources = raw.sources.map((s: unknown) => {
    if (!isObject(s) || !ident(s.project) || !ident(s.workspace) || !ident(s.verificationId, 80)
      || !hex(s.reportDigest) || !hex(s.evidenceDigest) || typeof s.image !== 'string' || !/^node@sha256:[a-f0-9]{64}(?![\s\S])/.test(s.image)) throw new Error('Invalid shared source');
    const key = JSON.stringify([s.project, s.workspace, s.verificationId]);
    if (seen.has(key)) throw new Error('Duplicate shared source'); seen.add(key);
    return { project: s.project, workspace: s.workspace, verificationId: s.verificationId, reportDigest: s.reportDigest, evidenceDigest: s.evidenceDigest, image: s.image };
  });
  const projects = new Set(sources.map(s => s.project)).size;
  const images = new Set(sources.map(s => s.image)).size;
  if (projects !== raw.verifiedProjects || images !== raw.verifiedImages) throw new Error('Inconsistent shared counts');
  if (raw.eligible ? projects < 3 || images < 2 || raw.reasons.length !== 0 : raw.reasons.length === 0) throw new Error('Inconsistent shared eligibility');
  return { status: raw.eligible ? 'eligible' : 'ineligible', publication, ...(raw.eligible ? {} : { reason: 'shared-evidence-ineligible' }), evidenceDigest: raw.evidenceDigest, projects, images, sources };
}

/** Fetches shared evidence from the configured native peer with bounded time, size and request count. */
export function sharedReader(base: string, transport: typeof fetch = fetch): SharedReader {
  let origin: string | undefined;
  try { const u = new URL(base); if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) origin = u.origin; } catch { /* unavailable below */ }
  const signal = AbortSignal.timeout(8000);
  const cache = new Map<string, Promise<unknown>>();
  const ids = new Set<string>();
  return async (publication, candidate, problem) => {
    if (typeof publication !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,199}(?![\s\S])/.test(publication)) return unavailable(publication);
    if (!origin) return unavailable(publication, 'invalid-configured-peer');
    if (!ids.has(publication)) { if (ids.size >= 8) return unavailable(publication); ids.add(publication); }
    try {
      let pending = cache.get(publication);
      if (!pending) {
        pending = (async () => {
          const response = await transport(new URL('/api/oporahub/harness-verifier/eligibility/shared', origin), {
            method: 'POST', redirect: 'error', credentials: 'omit', signal,
            headers: { origin, accept: 'application/json', 'content-type': 'application/json', 'cache-control': 'no-store', 'X-Opora-Actor': 'agent; name=office-harness' },
            body: JSON.stringify({ publication }),
          });
          if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('unavailable'); }
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
          try { for (;;) { const n = await reader.read(); if (n.done) break; size += n.value.byteLength; if (size > 256 * 1024) throw new Error('oversize'); chunks.push(n.value); } }
          finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        })();
        cache.set(publication, pending);
      }
      const raw = await pending;
      // Response cache is transport-only: validate separately against each invocation's scope.
      return parseSharedEvidence(raw, publication, candidate, problem);
    } catch { return unavailable(publication); }
  };
}
