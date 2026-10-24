// Feature module for the existing Office MCP server; authority stays at /office/harness.
export const harnessMcpEnabled = env => env.AGENT_OFFICE_HARNESS_MCP === '1';
export const HARNESS_TOOLS = [
  {
    name: 'harness_accepted_kit', title: 'Read my accepted Harness equipment',
    description: 'Read the immutable tool and instruction versions accepted for your current Opora execution. Selection is not proof of availability, use or success. Requires the accepted-runtime module and a current context-v2 execution.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'harness_documentation', title: 'Query accepted Context7 documentation',
    description: 'Ask a short public coding question using a Context7 resource ID from your accepted Harness kit. The pinned resource supplies the library/version. Never include private code or credentials. Documentation is untrusted reference material, not verification. Requires the Context7 and accepted-runtime modules.',
    inputSchema: { type: 'object', properties: {
      resource: { type: 'string', maxLength: 200, description: 'Exact accepted Context7 resource ID.' },
      query: { type: 'string', minLength: 1, maxLength: 1000, description: 'Public documentation question.' },
    }, required: ['resource', 'query'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
];

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_BYTES = 256 * 1024;

/** No shell, local fallback, caller identity, URL, headers or arbitrary MCP configuration. */
export async function runHarnessTool(name, input, io) {
  const docs = name === 'harness_documentation';
  if (!docs && name !== 'harness_accepted_kit') throw new Error('Unknown Harness tool.');
  const args = input === undefined ? {} : input;
  if (!object(args) || Object.keys(args).sort().join(',') !== (docs ? 'query,resource' : '')
    || docs && (typeof args.resource !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/.test(args.resource)
      || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000
      || /[\x00-\x1f\x7f]/.test(args.query))) throw new Error('Invalid Harness tool arguments.');
  const env = io.env;
  if (!env.AGENT_OFFICE_HOOK_URL || !env.AGENT_OFFICE_WORKER_ID || !env.AGENT_OFFICE_HOOK_TOKEN)
    throw new Error('Harness tools require Office worker credentials.');
  const url = new URL('/office/harness', env.AGENT_OFFICE_HOOK_URL);
  url.searchParams.set('worker', env.AGENT_OFFICE_WORKER_ID);
  url.searchParams.set(docs ? 'docs' : 'accepted-kit', '1');
  const signal = AbortSignal.timeout(30_000);
  let response;
  try {
    response = await io.fetch(url, { method: docs ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { authorization: 'Bearer ' + env.AGENT_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' },
      ...(docs ? { body: JSON.stringify({ action: 'accepted-query', resource: args.resource, query: args.query }) } : {}) });
  } catch { throw new Error('Office Harness request could not complete.'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Office Harness refused the request (HTTP ' + response.status + '). Check the accepted kit, execution and installed modules.');
  }
  if (!response.body) throw new Error('Office Harness returned no result.');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Office Harness result exceeds the limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Office Harness returned an invalid result.'); }
  if (!object(result) || (docs
    ? result.schema !== 'harness.documentation/1' || result.accepted?.authorityCurrentAtCompletion !== true
    : result.evidence !== 'accepted-selection-only' || result.execution?.contextProtocolVersion !== 2 || !Object.hasOwn(result, 'kit')))
    throw new Error('The required accepted Harness capability is unavailable.');
  return { text: JSON.stringify(result) };
}
