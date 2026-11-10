import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desiredRuleset, run, canonical } from '../scripts/rulesets.mjs';
import { percentile, durations } from '../actions/eta/stats.mjs';
import { awaitArtifact } from '../actions/await-artifact/await.mjs';
const template=JSON.parse(readFileSync(new URL('../rulesets/main.json',import.meta.url)));
const config={rulesetId:123,requiredChecks:[{context:'verify'}],checkTimeoutMinutes:15};
test('percentiles interpolate sorted samples without mutation',()=>{
  const values=[100,1,4,2]; assert.equal(percentile(values,.5),3); assert.equal(percentile([0,10],.9),9); assert.deepEqual(values,[100,1,4,2]);
  assert.equal(percentile([],.5),null);assert.equal(percentile([7],.9),7);assert.equal(percentile([2,2],.9),2);assert.throws(()=>percentile([-1],.9));
});
test('job durations exclude failed and malformed samples',()=>{
  const job={conclusion:'success',started_at:'2026-11-10T00:00:00Z',completed_at:'2026-11-10T00:01:00Z'};
  assert.deepEqual(durations([job,{...job,conclusion:'failure'},{...job,completed_at:null},{...job,started_at:job.completed_at,completed_at:job.started_at}]),[60000]);
});
test('ruleset diff never writes and apply verifies canonical readback',()=>{
  const desired=desiredRuleset(template,config);let state={...desired,enforcement:'disabled'};const calls=[];
  const api=(method,endpoint,body)=>{calls.push(method); if(method==='PUT')state=body;return state;};
  assert.equal(run('diff','org/repo',template,{'org/repo':config},api).changed,true);assert.deepEqual(calls,['GET']);
  assert.equal(run('apply','org/repo',template,{'org/repo':config},api).changed,true);assert.deepEqual(calls,['GET','GET','PUT','GET']);
  assert.equal(run('apply','org/repo',template,{'org/repo':config},api).changed,false);
  assert.equal(desired.rules.find(r=>r.type==='merge_queue').parameters.check_response_timeout_minutes,15);
  assert.deepEqual(canonical([{a:2},{a:1}]),[{a:1},{a:2}]);
});
test('ruleset fails closed on invalid scope, empty checks and readback mismatch',()=>{
  assert.throws(()=>desiredRuleset(template,{...config,requiredChecks:[]}));
  assert.throws(()=>run('diff','org/missing',template,{},()=>{}));
  const desired=desiredRuleset(template,config);
  assert.throws(()=>run('apply','org/repo',template,{'org/repo':config},()=>({...desired,target:'tag'})),/outside main/);
  assert.throws(()=>run('apply','org/repo',template,{'org/repo':config},()=>({...desired,enforcement:'disabled'})),/readback/);
});
test('artifact polls pages, ignores expired artifacts, and returns exact name',async()=>{
  let clock=0;let polls=0;
  const artifact=await awaitArtifact({name:'build',timeoutSeconds:4,intervalSeconds:1,now:()=>clock,sleep:async ms=>{clock+=ms;},request:async()=>({artifacts:++polls===1?[{name:'build',expired:true}]:[{name:'build',expired:false,id:42}]})});
  assert.equal(artifact.id,42);assert.equal(polls,2);
});
test('artifact deadline is hard, rejects bad limits and propagates API errors',async()=>{
  let clock=0;
  await assert.rejects(awaitArtifact({name:'absent',timeoutSeconds:2,now:()=>clock,sleep:async ms=>{clock+=ms;},request:async()=>({artifacts:[]})}),/within 2 seconds/);assert.equal(clock,2000);
  await assert.rejects(awaitArtifact({name:'x',timeoutSeconds:0}),/timeout/);
  await assert.rejects(awaitArtifact({name:'x',timeoutSeconds:2,request:async()=>{throw new Error('403');}}),/403/);
});
