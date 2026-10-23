import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { evaluatePair } from '../src/server/harness/paired-evaluation.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const ids={base:'script:base',candidate:'script:candidate',plan:'test:paired'};
const scripts={ [ids.base]:'console.log("same")', [ids.candidate]:'console.log("same")' };
const plan={schema:'harness.paired-node/1',problem:'typescript',baseline:ids.base,candidate:ids.candidate,cases:[{id:'case:a',args:['--same'],expectedStdout:'same\n'},{id:'case:b',args:['--same'],expectedStdout:'same\n'},{id:'case:c',args:['--third'],expectedStdout:'same\n'}]};
const makeReceipt=()=>{const resources:any[]=[{resource:ids.plan,category:'testing',content:JSON.stringify(plan),digest:sha(JSON.stringify(plan)),requires:[]}];for(const [resource,content] of Object.entries(scripts))resources.push({resource,category:'scripts',content,digest:sha(content),requires:['command:node']});return {execution:{executionId:randomUUID(),epoch:2,project:'p',workspace:'w',nodeId:'n',acceptedRevision:'a'.repeat(40),assignmentDigest:'b'.repeat(64)},kit:{schema:'harness.kit/1',problems:['evaluation:paired-node'],resources}};};
const success=(receipt:any,resource:string,args:string[],out='same\n',patch:any={})=>({invocationId:randomUUID(),execution:receipt.execution,resource:{id:resource,digest:sha(scripts[resource as keyof typeof scripts])},adapter:'node-readonly/1',nodeVersion:'v24.1.0',exitCode:0,reason:'completed',durationMs:2,outputBytes:Buffer.byteLength(out),outcome:'pass',authorityCurrentAtCompletion:true,cleanupComplete:true,stdout:out,...patch});
test('uses same args, alternates order, and treats expected output mismatch as fixture failure',async()=>{
 const receipt=makeReceipt(), calls:any[]=[];
 const result=await evaluatePair(async()=>receipt,async(_read,res,args)=>{calls.push({res,args});return success(receipt,res,args,res===ids.base?'wrong\n':'same\n');},ids.plan,process.cwd());
 assert.deepEqual(calls.map(x=>x.res),[ids.base,ids.candidate,ids.candidate,ids.base,ids.base,ids.candidate]);assert.ok(calls.every((x,i)=>JSON.stringify(x.args)===JSON.stringify(plan.cases[Math.floor(i/2)].args)));
 assert.equal(result.baseline.pass,0);assert.equal(result.candidate.pass,3);assert.equal(result.baseline.fail,3);assert.equal(result.comparison.improvements,3);
 assert.equal(result.harnessInvocations[0].outcome,'pass');assert.equal(result.trials[0].outcome,'fail');assert.equal(result.trials[0].reason,'output-mismatch');
});
test('candidate improvement with one regression is blocked despite positive pass difference',async()=>{
 const receipt=makeReceipt();
 const mixed=await evaluatePair(async()=>receipt,async(_read,res,args)=>success(receipt,res,args,
   res===ids.base&&args[0]!=='--third'?'bad\n':res===ids.candidate&&args[0]==='--third'?'bad\n':'same\n'),ids.plan,process.cwd());
 assert.equal(mixed.baseline.pass,1);assert.equal(mixed.candidate.pass,2);assert.equal(mixed.comparison.passDifference,1);
 assert.equal(mixed.comparison.improvements,2);assert.equal(mixed.comparison.regressions,1);assert.equal(mixed.comparison.conclusion,'regression-on-fixtures');
});
test('retains planned denominator and stops after errors or authority/cleanup failure',async()=>{
 const receipt=makeReceipt();let calls=0;
 const failed=await evaluatePair(async()=>receipt,async()=>{calls++;throw new Error('private adapter detail');},ids.plan,process.cwd());
 assert.equal(failed.plannedInvocations,6);assert.equal(failed.observedInvocations,0);assert.equal(failed.baseline.unknown+failed.candidate.unknown,6);assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify(failed),/private adapter detail|same\n|--same/);
 const revoked=await evaluatePair(async()=>receipt,async(_read,res,args)=>success(receipt,res,args,'same\n',{authorityCurrentAtCompletion:false,outcome:'fail',reason:'execution-changed'}),ids.plan,process.cwd());
 assert.equal(revoked.plannedInvocations,6);assert.equal(revoked.observedInvocations,1);assert.equal(revoked.status,'incomplete');assert.equal(revoked.trials[0].reason,'authority-not-current');
 let count=0;const dirty=await evaluatePair(async()=>receipt,async(_read,res,args)=>{count++;return success(receipt,res,args,'same\n',{cleanupComplete:false,outcome:'fail',reason:'completed'});},ids.plan,process.cwd());
 assert.equal(count,1);assert.equal(dirty.status,'incomplete');assert.equal(dirty.trials[0].reason,'cleanup-incomplete');
});
test('rejects wrong identity, resource digest, duplicate invocation and incomplete final authority',async()=>{
 const receipt=makeReceipt();
 const wrong=await evaluatePair(async()=>receipt,async(_read,res,args)=>success(receipt,res,args,'same\n',{execution:{...receipt.execution,project:'other'}}),ids.plan,process.cwd());assert.equal(wrong.observedInvocations,0);
 const digestBad=await evaluatePair(async()=>receipt,async(_read,res,args)=>success(receipt,res,args,'same\n',{resource:{id:res,digest:'0'.repeat(64)}}),ids.plan,process.cwd());assert.equal(digestBad.observedInvocations,0);
 let calls=0;const duplicate=await evaluatePair(async()=>receipt,async(_read,res,args)=>success(receipt,res,args,'same\n',{invocationId:'123e4567-e89b-42d3-a456-426614174000'}),ids.plan,process.cwd());assert.equal(duplicate.observedInvocations,1);assert.equal(duplicate.status,'incomplete');
 const changed={...receipt,execution:{...receipt.execution,epoch:3}};const final=await evaluatePair(async()=>{calls++;return calls===1?receipt:changed;},async(_read,res,args)=>success(receipt,res,args),ids.plan,process.cwd());assert.equal(final.authorityCurrentAtCompletion,false);assert.equal(final.status,'incomplete');
 let reads=0;const midrun=await evaluatePair(async()=>{reads++;return reads<=1?receipt:changed;},async(read,res,args)=>{await read();return success(receipt,res,args);},ids.plan,process.cwd());
 assert.equal(midrun.observedInvocations,0);assert.equal(midrun.plannedInvocations,6);assert.equal(midrun.status,'incomplete');assert.equal(midrun.trials.filter(t=>t.outcome==='unknown').length,6);
});
test('stops at the launch budget without waiting on a long timer',async(t)=>{
 const receipt=makeReceipt(); let calls=0, now=0;
 t.mock.method(performance,'now',()=>now++ === 0 ? 0 : 60_001);
 const result=await evaluatePair(async()=>receipt,async(_read,res,args)=>{calls++;return success(receipt,res,args);},ids.plan,process.cwd());
 assert.equal(calls,0);assert.equal(result.plannedInvocations,6);assert.equal(result.observedInvocations,0);
 assert.equal(result.status,'incomplete');assert.equal(result.trials[0].reason,'launch-budget-exhausted');
});
