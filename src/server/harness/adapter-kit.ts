/** Optional full accepted-kit validator; a missing/older runtime never enables v2. */
const modulePath = './accepted-kit.js';
let validator: Promise<(kit: unknown) => unknown> | undefined;

export async function validateAdapterKit(kit: unknown) {
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) throw new Error('Accepted kit is unavailable.');
  const schema = (kit as { schema?: unknown }).schema;
  if (schema === 'harness.kit/1') return; // Existing adapters retain their v1 validation.
  if (schema !== 'harness.kit/2') throw new Error('Unsupported accepted kit schema.');
  validator ??= import(modulePath).then(module => {
    if (typeof module.validateAcceptedKit !== 'function') throw new Error('Missing accepted kit validator.');
    return module.validateAcceptedKit as (value: unknown) => unknown;
  }).catch(() => { throw new Error('Accepted kit v2 validation is unavailable in this installation.'); });
  const validate = await validator;
  validate(kit); // Full resource and metadata validation; never strip selection to bypass an old reader.
}
