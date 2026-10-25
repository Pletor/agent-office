export function searchCatalog(catalog, args) {
  const [query, flag, category] = args;
  if (!query?.trim() || query.length > 200 || args.length !== 1 && (args.length !== 3 || flag !== '--category' || !category)) throw new Error('Usage: --search "words" [--category CATEGORY]');
  if (!Array.isArray(catalog?.entries)) throw new Error('Invalid catalog response');
  const words = query.toLowerCase().trim().split(/\s+/);
  const entries = catalog.entries.filter(entry => (!category || entry.category === category) && words.every(word => (entry.title + ' ' + entry.path + ' ' + entry.source).toLowerCase().includes(word)));
  return { ...catalog, entries, query, category: category ?? null };
}
