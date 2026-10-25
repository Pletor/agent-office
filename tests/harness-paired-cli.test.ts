import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function cli(env:NodeJS.ProcessEnv,args:string[]){try{const r=await run(process.execPath,[path.join(root,'bin/office-harness.js'),...args],{cwd:root,env,timeout:10000,maxBuffer:256*1024});return {code:0,out:r.stdout,err:r.stderr};}catch(e:any){return {code:e.code??1,out:e.stdout??'',err:e.stderr??''};}}
test('evaluation CLI requires hook credentials, strict arguments, and the optional adapter',async()=>{
 const local=await cli({PATH:process.env.PATH??''},['--evaluate-pair','test:paired']);assert.notEqual(local.code,0);assert.match(local.err,/worker hook credentials/i);assert.doesNotMatch(local.out+local.err,/PRIVATE_HOOK_TOKEN/);
 const bad=await cli({PATH:process.env.PATH??'',AGENT_OFFICE_HOOK_URL:'http://127.0.0.1:1',AGENT_OFFICE_WORKER_ID:'worker',AGENT_OFFICE_HOOK_TOKEN:'PRIVATE_HOOK_TOKEN'},['--evaluate-pair','test:paired','extra']);assert.notEqual(bad.code,0);assert.match(bad.err,/Usage/i);assert.doesNotMatch(bad.out+bad.err,/PRIVATE_HOOK_TOKEN/);
 if (existsSync(path.join(root,'dist/server/server/harness/invoke-node.js'))) {
  const peer=await cli({PATH:process.env.PATH??'',AGENT_OFFICE_HOOK_URL:'http://127.0.0.1:1',AGENT_OFFICE_WORKER_ID:'worker',AGENT_OFFICE_HOOK_TOKEN:'PRIVATE_HOOK_TOKEN'},['--evaluate-pair','test:paired']);
  assert.notEqual(peer.code,0);assert.doesNotMatch(peer.out+peer.err,/PRIVATE_HOOK_TOKEN/);
 } else {
  const missing=await cli({PATH:process.env.PATH??'',AGENT_OFFICE_HOOK_URL:'http://127.0.0.1:1',AGENT_OFFICE_WORKER_ID:'worker',AGENT_OFFICE_HOOK_TOKEN:'PRIVATE_HOOK_TOKEN'},['--evaluate-pair','test:paired']);
  assert.notEqual(missing.code,0);assert.match(missing.err,/requires the accepted Node invocation adapter/i);assert.doesNotMatch(missing.out+missing.err,/PRIVATE_HOOK_TOKEN/);
 }
});
