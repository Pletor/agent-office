/** Whitelist native metadata; stdout, stderr, arguments and future output fields never cross this boundary. */
export function invocationObservation(receipt: Record<string, unknown>) {
  const keys = ['invocationId', 'execution', 'resource', 'adapter', 'nodeVersion', 'exitCode', 'reason',
    'durationMs', 'outputBytes', 'outcome', 'authorityCurrentAtCompletion', 'cleanupComplete', 'evidence',
    'independentlyVerified', 'causalContribution', 'promotionAllowed', 'tokens', 'cost'];
  return { schema: 'harness.invocation-metadata/1', ...Object.fromEntries(keys.map(key => [key, receipt[key]])) };
}
