#!/usr/bin/env node
// PostToolUse hook: after an edit of a .ts/.tsx file, type-check the project it belongs to and hand
// the errors straight back to the agent. Deterministic: the same checkout gives the same lines.
//   stdin: the runner's hook event as JSON ({ tool_input: { file_path } }); a file path argument works too.
// Exit 0 when the types are fine or the file is not TypeScript, 2 with the errors on stderr otherwise
// (exit 2 is how a PostToolUse hook shows its output to the model).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

let file = process.argv[2];
if (!file) {
  try { file = JSON.parse(readFileSync(0, 'utf8') || '{}').tool_input?.file_path; } catch { file = undefined; }
}
if (!file || !/\.tsx?$/.test(file)) process.exit(0);
const root = process.cwd(), rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
if (rel.startsWith('..')) process.exit(0);
// This repository splits client and server; any other takes its tsconfig.json.
const config = existsSync(path.join(root, 'tsconfig.json')) ? 'tsconfig.json'
  : rel.startsWith('src/client/') ? 'tsconfig.client.json' : 'tsconfig.server.json';
if (!existsSync(path.join(root, config))) process.exit(0);
const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
if (!existsSync(tsc)) { console.error('TypeScript tu není nainstalovaný; spusťte npm install.'); process.exit(0); }
try {
  execFileSync(process.execPath, [tsc, '-p', config, '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
} catch (error) {
  const lines = String(error.stdout ?? '').split('\n').filter(line => /error TS\d+/.test(line));
  const mine = lines.filter(line => line.startsWith(rel));
  console.error(`Kontrola typů (${config}) po úpravě ${rel}: ${lines.length} chyb, ${mine.length} v tomto souboru.`);
  console.error([...mine, ...lines.filter(line => !mine.includes(line))].slice(0, 20).join('\n'));
  process.exit(2);
}
