export function recommendationArgs(argv) {
  const args = [...argv], problem = args.shift() ?? '', capabilities = [];
  let kitSchema = 'harness.kit/1', schemaSeen = false;
  const invalid = () => new Error('Usage: --recommend PROBLEM [--capability ID]... [--kit-schema harness.kit/1|harness.kit/2]');
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value) throw invalid();
    if (flag === '--capability') capabilities.push(value);
    else if (flag === '--kit-schema' && !schemaSeen && ['harness.kit/1', 'harness.kit/2'].includes(value)) {
      kitSchema = value; schemaSeen = true;
    } else throw invalid();
  }
  return { problem, capabilities, kitSchema };
}
