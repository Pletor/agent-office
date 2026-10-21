/** Sparse context negotiation is independent of authority budget protocol. */
export type ContextVersion = 1 | 2;
export interface ContextValidation {
  contextProtocolVersion: 2; originAcceptedRevision: string; checkedAcceptedRevision: string;
  acceptedRevisionsChecked: number; liveTransitionsChecked: number;
  acceptedScopeUnchanged: true; liveScopeUnchanged: true;
}
export const EXECUTION_INSTRUCTIONS_VERSION = 'opora-office-execution/2';
const hash = (value: unknown, length = 40) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new Error('Canvas context authority is invalid or unsupported'); };
const PROOF_KEYS = ['contextProtocolVersion', 'originAcceptedRevision', 'checkedAcceptedRevision',
  'acceptedRevisionsChecked', 'liveTransitionsChecked', 'acceptedScopeUnchanged', 'liveScopeUnchanged'];

export function contextVersionFromEnvironment(value = process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION): ContextVersion {
  if (value === undefined) return 1;
  if (value === '2') return 2;
  throw new Error('AGENT_OFFICE_OPORA_CONTEXT_VERSION must be unset or 2');
}
export function validateContextProof(value: unknown, origin: string): ContextValidation {
  if (!object(value) || Object.keys(value).length !== PROOF_KEYS.length || !PROOF_KEYS.every(key => key in value)
    || value.contextProtocolVersion !== 2 || value.originAcceptedRevision !== origin || !hash(origin)
    || !hash(value.checkedAcceptedRevision) || value.acceptedScopeUnchanged !== true || value.liveScopeUnchanged !== true
    || !Number.isSafeInteger(value.acceptedRevisionsChecked) || (value.acceptedRevisionsChecked as number) < 1
    || (value.acceptedRevisionsChecked as number) > 256 || !Number.isSafeInteger(value.liveTransitionsChecked)
    || (value.liveTransitionsChecked as number) < 0 || (value.liveTransitionsChecked as number) > 256) return fail();
  return value as unknown as ContextValidation;
}
export function validateContextVersion(value: unknown): ContextVersion {
  if (value === undefined || value === 1) return 1;
  if (value === 2) return 2;
  return fail();
}
export function validateSparseAuthority(value: Record<string, unknown>) {
  const version = validateContextVersion(value.contextProtocolVersion);
  if (['pin', 'privatePin', 'contextPin', 'originPin', 'rawSnapshot', 'secret', 'pin_json', 'pin_digest', 'proof_json']
    .some(key => key in value)) return fail();
  if (version === 1) {
    if (value.contextValidation !== undefined || (object(value.assignment) && value.assignment.contextProtocolVersion === 2)) return fail();
    return;
  }
  if (!object(value.assignment) || value.assignment.contextProtocolVersion !== 2
    || !hash(value.assignment.contextVersion, 64)) return fail();
  validateContextProof(value.contextValidation, value.acceptedRevision as string);
}
export function validateContextNegotiation(value: Record<string, unknown>, expected: ContextVersion) {
  if (validateContextVersion(value.contextProtocolVersion) !== expected) return fail();
  if (expected === 2 && value.available === true && !hash(value.contextVersion, 64)) return fail();
}
export function sparseInstructions() {
  return `Office static execution instructions: ${EXECUTION_INSTRUCTIONS_VERSION}.
Sparse context protocol 2: use only the immutable assignment and this versioned execution protocol. No live task preparation, harness snapshot or REA brief is appended.`;
}
