export function probeArgs(args) {
  if (args.length !== 1) throw new Error('Usage: office-harness --probe RUNNER (local) | --probe (authenticated worker)');
  return args[0];
}
