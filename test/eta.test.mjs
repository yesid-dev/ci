import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../actions/eta/eta.mjs';
test('ETA warns while a command is running and preserves its failure exit code', async()=>{
  const warnings=[];
  const result=await runCommand({executable:process.execPath,args:['-e','setTimeout(()=>process.exit(7),150)'],deadline:Date.now()+40,warn:()=>warnings.push(Date.now())});
  assert.equal(result,7);assert.equal(warnings.length,1);
});
test('ETA clears warning timer when the command finishes early',async()=>{
  const warnings=[];
  assert.equal(await runCommand({executable:process.execPath,args:['-e','process.exit(0)'],deadline:Date.now()+60000,warn:()=>warnings.push(true)}),0);
  assert.deepEqual(warnings,[]);
});

test('history searches past failed jobs and across pages for the last 20 successful samples',async()=>{
  const { samplesFor }=await import('../actions/eta/eta.mjs');
  const seen=[];
  const request=async endpoint=>{
    seen.push(endpoint);
    if(endpoint.includes('/workflows/'))return {workflow_runs:endpoint.endsWith('page=1')?Array.from({length:100},(_,id)=>({id,event:'push',head_branch:'main',head_repository:{full_name:'org/ci'}})):Array.from({length:30},(_,id)=>({id:id+100,event:'push',head_branch:'main',head_repository:{full_name:'org/ci'}}))};
    const id=Number(endpoint.match(/runs\/(\d+)/)[1]);
    return {jobs:[{name:'layout (2)',conclusion:id<100?'failure':'success',started_at:'2026-11-10T00:00:00Z',completed_at:'2026-11-10T00:00:01Z'}]};
  };
  assert.deepEqual(await samplesFor(5,'layout (2)',999,request,'org/ci'),Array(20).fill(1000));
  assert.ok(seen.some(e=>e.includes('/workflows/')&&e.endsWith('page=2')));
  assert.equal(seen.filter(e=>e.includes('/jobs?')).length,120);
});

test('main history excludes fork PRs, owning-repo PRs, missing origins and other branches',async()=>{
  const {samplesFor}=await import('../actions/eta/eta.mjs');
  const trusted={event:'push',head_branch:'main',head_repository:{full_name:'org/ci'}};
  const runs=[
    {...trusted,id:1,event:'pull_request',head_repository:{full_name:'fork/ci'}},
    {...trusted,id:2,event:'pull_request'},
    {...trusted,id:3,head_repository:null},
    {...trusted,id:4,head_branch:'feature'},
    {...trusted,id:5,event:'pull_request_target'},
    {...trusted,id:6,head_repository:{full_name:'fork/ci'}},
    {...trusted,id:7,event:'schedule'},
    {...trusted,id:8,event:'workflow_dispatch'}
  ];
  const jobsRequested=[];
  const request=async endpoint=>{
    if(endpoint.includes('/workflows/'))return {workflow_runs:runs};
    const id=Number(endpoint.match(/runs\/(\d+)/)[1]);jobsRequested.push(id);
    return {jobs:[{name:'build',conclusion:'success',started_at:'2026-11-10T00:00:00Z',completed_at:'2026-11-10T00:00:10Z'}]};
  };
  assert.deepEqual(await samplesFor(5,'build',999,request,'org/ci'),[10000,10000]);
  assert.deepEqual(jobsRequested,[7,8]);
});
