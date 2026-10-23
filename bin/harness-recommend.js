export function recommendationArgs(argv) {
  const args = [...argv], problem = args.shift() ?? '', capabilities = [];
  while (args.length) {
    if (args.shift() !== '--capability' || !args[0]) throw new Error('Usage: --recommend PROBLEM [--capability ID]...');
    capabilities.push(args.shift());
  }
  return { problem, capabilities };
}
