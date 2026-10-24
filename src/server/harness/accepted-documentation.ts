import { context7, documentationQuery, DocumentationError } from './context7.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = () => new DocumentationError('Accepted Context7 resource or current execution is unavailable.', 409);
const runtimePath = './accepted-kit.js';

/** Optional accepted-runtime integration; never resolve a live catalog or caller supplied kit. */
export async function acceptedDocumentation(input: unknown, controller: unknown, worker: string,
  options: Parameters<typeof context7>[1] = {}) {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'action,query,resource'
    || input.action !== 'accepted-query' || typeof input.resource !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/.test(input.resource))
    throw new DocumentationError('Use an accepted resource ID and a public documentation question.', 400);
  let runtime: { acceptedKit: (assignment: Record<string, unknown>, node: string) => any };
  try { runtime = await import(runtimePath); } catch { throw fail(); }
  if (typeof runtime.acceptedKit !== 'function' || !object(controller) || typeof controller.assignmentFor !== 'function') throw fail();
  const snapshot = () => {
    try {
      const current = structuredClone(controller.assignmentFor(worker));
      if (!current || current.contextProtocolVersion !== 2) throw fail();
      const kit = runtime.acceptedKit(current.assignment, current.nodeId);
      const matches = kit?.resources.filter((r: any) => r.resource === input.resource) ?? [];
      const resource = matches[0];
      if (matches.length !== 1 || resource.category !== 'mcp'
        || JSON.stringify(resource.requires) !== '["mcp:context7"]') throw fail();
      const config = JSON.parse(resource.content);
      if (!object(config) || Object.keys(config).sort().join(',') !== 'library,schema'
        || config.schema !== 'harness.context7/1') throw fail();
      const query = documentationQuery({ action: 'query', library: config.library, query: input.query });
      const { executionId, project, workspace, nodeId, epoch, acceptedRevision, assignmentDigest, contextProtocolVersion } = current;
      const execution = { executionId, project, workspace, nodeId, epoch, acceptedRevision, assignmentDigest, contextProtocolVersion };
      return { execution, resource: { id: resource.resource, digest: resource.digest }, query,
        identity: JSON.stringify([current, resource]) };
    } catch { throw fail(); }
  };
  const before = snapshot();
  const documentation = await context7(before.query, options);
  if (snapshot().identity !== before.identity) throw fail();
  return { ...documentation, accepted: { execution: before.execution, resource: before.resource,
    adapter: 'context7-documentation/1', authorityCurrentAtCompletion: true },
    independentlyVerified: false, causalContribution: false, promotionAllowed: false };
}
