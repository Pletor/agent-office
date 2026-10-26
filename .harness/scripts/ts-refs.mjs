#!/usr/bin/env node
// Definitions and references of a TypeScript symbol through the repository's own language server
// (TypeScript 7: `tsc --lsp --stdio`). Deterministic: same checkout, same sorted `file:line:col` lines.
//   node .harness/scripts/ts-refs.mjs refs SYMBOL      every use, the declaration included
//   node .harness/scripts/ts-refs.mjs def SYMBOL       where it is declared
// Exit 0 with results, 1 when the symbol is not declared in src/, 2 on a usage or server error.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [mode, symbol] = process.argv.slice(2);
if (!['refs', 'def'].includes(mode) || !/^[A-Za-z_$][\w$]*$/.test(symbol ?? '')) {
  console.error('Použití: node .harness/scripts/ts-refs.mjs refs|def SYMBOL');
  process.exit(2);
}
const root = process.cwd();
const exe = path.join(root, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
if (!existsSync(exe)) { console.error('Nativní TypeScript 7 (' + path.relative(root, exe) + ') tu není; spusťte npm install.'); process.exit(2); }

// The declaration, found by a fixed scan of src/ in name order: the first file that declares the symbol wins.
const DECLARED = new RegExp(`(?:function\\*?|class|interface|type|enum|const|let|var)\\s+${symbol.replace(/\$/g, '\\$')}\\b`);
function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) { if (name !== 'node_modules') yield* files(file); }
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield file;
  }
}
// Every file that names the symbol is opened too: without a tsconfig.json the server sees only open
// files, and a reference can only be where the name is written.
const WORD = new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`);
let at;
const naming = [];
for (const file of files(path.join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  if (!WORD.test(text)) continue;
  naming.push({ file, text });
  const lines = text.split('\n'), line = at ? -1 : lines.findIndex(row => DECLARED.test(row));
  if (line >= 0) at = { file, line, character: lines[line].search(WORD) };
}
if (!at) { console.error(`${symbol} není deklarovaný v src/.`); process.exit(1); }

const server = spawn(exe, ['--lsp', '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
let buffer = Buffer.alloc(0), next = 1;
const waiting = new Map();
server.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const head = buffer.indexOf('\r\n\r\n');
    if (head < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, head).toString())?.[1]);
    if (buffer.length < head + 4 + length) return;
    const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
    buffer = buffer.subarray(head + 4 + length);
    if (process.env.TS_REFS_DEBUG) console.error('<', JSON.stringify(message).slice(0, 300));
    // The server asks the client too (configuration, capability registration): answer, or it waits for ever.
    if (message.method && message.id !== undefined) send({ id: message.id, result: message.method === 'workspace/configuration' ? (message.params?.items ?? []).map(() => null) : null });
    else if (message.id !== undefined && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  }
});
const send = message => { const body = JSON.stringify({ jsonrpc: '2.0', ...message }); server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
const request = (method, params) => new Promise((resolve, reject) => {
  const id = next++; waiting.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result)); send({ id, method, ...(params === undefined ? {} : { params }) });
});
const timer = setTimeout(() => { console.error('Jazykový server neodpověděl do 60 s.'); server.kill(); process.exit(2); }, 60_000);
try {
  const uri = pathToFileURL(at.file).href;
  await request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} });
  send({ method: 'initialized', params: {} });
  for (const { file, text } of naming) send({ method: 'textDocument/didOpen', params: { textDocument: { uri: pathToFileURL(file).href, languageId: 'typescript', version: 1, text } } });
  const position = { line: at.line, character: at.character };
  const result = mode === 'def'
    ? await request('textDocument/definition', { textDocument: { uri }, position })
    : await request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } });
  const locations = (Array.isArray(result) ? result : result ? [result] : []).map(item => item.uri ? item : { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange });
  const lines = [...new Set(locations.map(item => `${path.relative(root, fileURLToPath(item.uri)).split(path.sep).join('/')}:${item.range.start.line + 1}:${item.range.start.character + 1}`))]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  console.log(lines.join('\n'));
  await request('shutdown').catch(() => {});
  send({ method: 'exit' });
  clearTimeout(timer);
  process.exitCode = lines.length ? 0 : 1;
} catch (error) {
  console.error('Jazykový server: ' + error.message); server.kill(); process.exitCode = 2; clearTimeout(timer);
}
