/** Server-owned work-allocation snapshot, never an admission reservation. */
export interface FixtureExploration {
  status: 'available' | 'unavailable'; maxPercent: 5; baselineCards: number | null;
  admitted: number | null; remaining: number | null; eligible: boolean; reservation: false; policyDigest?: string;
}
const fail = (): never => { throw new Error('Invalid native exploration allocation'); };
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function parseExploration(value: unknown, admitted: number): FixtureExploration | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (v.schema !== 'harness.exploration-share/1' || v.maxPercent !== 5 || v.reservation !== false) return fail();
  if (v.status === 'unavailable') {
    if (v.baselineCards !== null || v.admitted !== null || v.remaining !== null || v.eligible !== false || v.policyDigest !== undefined) return fail();
    return { status: 'unavailable', maxPercent: 5, baselineCards: null, admitted: null, remaining: null, eligible: false, reservation: false };
  }
  if (v.status !== 'available' || !count(v.baselineCards) || !count(v.admitted) || v.admitted !== admitted
    || v.remaining !== Math.max(0, Math.floor(v.baselineCards / 19) - v.admitted)
    || v.eligible !== (Number(v.remaining) > 0) || typeof v.policyDigest !== 'string'
    || !/^[a-f0-9]{64}(?![\s\S])/.test(v.policyDigest)) return fail();
  return { status: 'available', maxPercent: 5, baselineCards: v.baselineCards, admitted: v.admitted,
    remaining: v.remaining as number, eligible: v.eligible as boolean, reservation: false, policyDigest: v.policyDigest };
}
