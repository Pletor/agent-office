export function docsQuery(action, args) {
  if (action === '--docs-accepted' && args.length === 2) return { action: 'accepted-query', resource: args[0], query: args[1] };
  if (!['--docs-resolve', '--docs'].includes(action) || args.length !== 2) throw new Error('Usage: office-harness --docs-resolve LIBRARY "public question" | --docs /owner/repo[/VERSION] "public question"');
  return { action: action === '--docs-resolve' ? 'resolve' : 'query', library: args[0], query: args[1] };
}
