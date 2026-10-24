import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePair } from '../src/server/harness/paired-plan.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const execution={executionId:'123e4567-e89b-42d3-a456-426614174000',epoch:1,project:'p',workspace:'w',nodeId:'n',acceptedRevision:'a'.repeat(40),assignmentDigest:'b'.repeat(64)};
function fixture(plan: unknown={schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:candidate',cases:[{id:'case:one',args:['--check'],expectedStdout:'ok\n'}]}) {
 const content=JSON.stringify(plan), script=(id:string,content:string)=>({resource:id,category:'scripts',content,digest:sha(content),requires:['command:node']});
 const p={slot:'testing.paired',resource:'test:paired',category:'testing',content,digest:sha(content),requires:[],provenance:{source:'accepted'}};
 return {execution,kit:{schema:'harness.kit/1',problems:['evaluation:paired-node'],resources:[p,{slot:'scripts.base',...script('script:base','console.log("ok")')},{slot:'scripts.candidate',...script('script:candidate','console.log("ok")')},{slot:'rules.other',resource:'other',category:'instructions',content:'x',digest:'0'.repeat(64),requires:[]}]} };
}
const rejects=(r:any,id='test:paired')=>assert.rejects(preparePair(r,id),/Invalid accepted paired plan/);
test('prepares only accepted testing plan and returns detached pinned identities',async()=>{
 const r=fixture(), prepared=await preparePair(r,'test:paired');
 assert.deepEqual(prepared.execution,execution); assert.deepEqual(prepared.plan.cases[0],{id:'case:one',args:['--check'],expectedStdout:'ok\n'});
 assert.equal(prepared.baseline.digest,sha('console.log("ok")')); assert.notEqual(prepared.resource.id,prepared.baseline.id);
 assert.deepEqual(Object.keys(prepared.execution),['executionId','epoch','project','workspace','nodeId','acceptedRevision','assignmentDigest']);
 assert.equal('provenance' in (prepared as any).resource,false);
 prepared.execution.project='mutated'; prepared.plan.cases[0].args[0]='mutated';
 assert.equal(r.execution.project,'p'); assert.equal(JSON.parse(r.kit.resources[0].content).cases[0].args[0],'--check');
});
test('rejects malformed plan shapes, ids, duplicates and overflow',async()=>{
 await rejects(fixture({schema:'harness.paired-node/2',problem:'typescript',baseline:'script:base',candidate:'script:candidate',cases:[]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:base',cases:[{id:'x',args:[],expectedStdout:''}]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:candidate',cases:[{id:'x',args:[],expectedStdout:''},{id:'x',args:[],expectedStdout:''}]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:candidate',extra:true,cases:[{id:'x',args:[],expectedStdout:''}]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:candidate',cases:Array.from({length:9},(_,i)=>({id:'c'+i,args:[],expectedStdout:''}))}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:candidate',cases:[{id:'x',args:['\ud800'],expectedStdout:''}]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base',candidate:'script:candidate',cases:[{id:'x',args:[],expectedStdout:'\0'}]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'typescript',baseline:'script:base\n',candidate:'script:candidate',cases:[{id:'x',args:[],expectedStdout:''}]}));
 await rejects(fixture({schema:'harness.paired-node/1',baseline:'script:base',candidate:'script:candidate',cases:[{id:'x',args:[],expectedStdout:''}]}));
 await rejects(fixture({schema:'harness.paired-node/1',problem:'',baseline:'script:base',candidate:'script:candidate',cases:[{id:'x',args:[],expectedStdout:''}]}));
});
test('rejects bad kit/resource digests, categories, requirements and missing resources',async()=>{
 const r=fixture(); r.kit.resources[0].digest='0'.repeat(64); await rejects(r);
 const ordinary=fixture(); ordinary.kit.problems=['typescript','security']; await rejects(ordinary);
 const noProblems=fixture(); delete (noProblems.kit as any).problems; await rejects(noProblems);
 const s=fixture(); s.kit.resources[1].requires=['command:node','command:node']; await rejects(s);
 const c=fixture(); c.kit.resources[2].category='tools'; await rejects(c);
 const d=fixture(); d.kit.resources.push({...d.kit.resources[1]}); await rejects(d);
 await rejects(fixture(),'test:missing');
});
