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

test('queued current job is selected by own ID and wrapped failure still runs',async()=>{
  const {runEta}=await import('../actions/eta/eta.mjs');const calls=[];const summary=[];let executions=0;
  const job={id:123,run_id:10,run_attempt:1,name:'test',status:'queued',started_at:'2026-11-10T00:00:00Z'};
  const request=async endpoint=>{
    calls.push(endpoint);
    if(endpoint==='actions/jobs/123')return job;
    if(endpoint==='actions/runs/10')return {id:10,workflow_id:3};
    if(endpoint.startsWith('actions/runs/10/jobs?'))return {jobs:[job]};
    return {workflow_runs:[]};
  };
  const env={ETA_CHECK_RUN_ID:'123',ETA_JOB_NAME:'test',ETA_COMMAND:'exit 7',ETA_BASH:'unused-by-injected-executor',GITHUB_RUN_ID:'10',GITHUB_RUN_ATTEMPT:'1',GITHUB_REPOSITORY:'org/ci'};
  const code=await runEta({env,request,writeSummary:text=>summary.push(text),execute:async()=>{executions++;return runCommand({executable:process.execPath,args:['-e','process.exit(7)'],deadline:null});}});
  assert.equal(code,7);assert.equal(executions,1);assert.ok(calls.includes('actions/jobs/123'));
  assert.ok(!calls.some(e=>e.startsWith('actions/runs/10/jobs?')));assert.match(summary.join(''),/Expected finish: unavailable \(no successful main job samples\)/);
});

const fixtureEnv={ETA_CHECK_RUN_ID:'123',ETA_JOB_NAME:'test',ETA_COMMAND:'exit 7',ETA_BASH:'injected',GITHUB_RUN_ID:'10',GITHUB_RUN_ATTEMPT:'1',GITHUB_REPOSITORY:'org/ci'};
const queuedJob={id:123,run_id:10,run_attempt:1,name:'test',status:'queued',started_at:'2026-11-10T00:00:00Z'};
const failedCommand=()=>runCommand({executable:process.execPath,args:['-e','process.exit(7)'],deadline:null});

test('queued job with history still produces percentiles and a live warning',async()=>{
  const {runEta}=await import('../actions/eta/eta.mjs');const summary=[];let warnings=0;let started=false;
  const request=async endpoint=>{
    assert.equal(started,true);
    if(endpoint==='actions/jobs/123')return queuedJob;
    if(endpoint==='actions/runs/10')return {id:10,workflow_id:3};
    if(endpoint.startsWith('actions/workflows/'))return {workflow_runs:[{id:9,event:'push',head_branch:'main',head_repository:{full_name:'org/ci'}}]};
    return {jobs:[{name:'test',conclusion:'success',started_at:'2026-11-10T00:00:00Z',completed_at:'2026-11-10T00:00:01Z'}]};
  };
  assert.equal(await runEta({env:fixtureEnv,request,writeSummary:t=>summary.push(t),identity:()=>{},warn:()=>warnings++,execute:()=>{started=true;return failedCommand();}}),7);
  assert.match(summary.join(''),/Expected finish: p50 .*; p90 /);assert.equal(warnings,1);
});

test('unavailable metadata cannot prevent execution or turn exit 7 into success',async t=>{
  const {runEta}=await import('../actions/eta/eta.mjs');
  const cases=[
    {name:'API failure',request:async()=>{throw new Error('GitHub API 403');},reason:/GitHub API 403/},
    {name:'wrong ID',job:{...queuedJob,id:124},reason:/identity does not match/},
    {name:'wrong run',job:{...queuedJob,run_id:11},reason:/identity does not match/},
    {name:'wrong attempt',job:{...queuedJob,run_attempt:2},reason:/identity does not match/},
    {name:'unknown start',job:{...queuedJob,started_at:null},reason:/start time unavailable/},
    {name:'missing job context',env:{...fixtureEnv,ETA_CHECK_RUN_ID:''},reason:/job.check_run_id unavailable/},
    {name:'wrong display name',job:{...queuedJob,name:'other'},reason:/job-name does not match/}
  ];
  for(const scenario of cases)await t.test(scenario.name,async()=>{
    const summary=[];let executions=0;
    const code=await runEta({env:scenario.env??fixtureEnv,request:scenario.request??(async()=>scenario.job),identity:()=>{},writeSummary:text=>summary.push(text),execute:()=>{executions++;return failedCommand();}});
    assert.equal(code,7);assert.equal(executions,1);assert.match(summary.join(''),/Expected finish: unavailable \(/);assert.match(summary.join(''),scenario.reason);
  });
});

test('pending telemetry is abandoned on command completion without delaying or hiding failure',async()=>{
  const {runEta}=await import('../actions/eta/eta.mjs');let signal;const summary=[];
  const code=await runEta({env:fixtureEnv,request:async(endpoint,options)=>{signal=options.signal;return new Promise(()=>{});},identity:()=>{},writeSummary:text=>summary.push(text),execute:failedCommand});
  assert.equal(code,7);assert.equal(signal.aborted,true);assert.match(summary.join(''),/Expected finish: unavailable \(command completed before ETA metadata was available\)/);
});

test('summary I/O failure cannot alter a failing command result',async()=>{
  const {runEta}=await import('../actions/eta/eta.mjs');let executions=0;
  assert.equal(await runEta({env:fixtureEnv,request:async()=>{throw new Error('unavailable');},writeSummary:()=>{throw new Error('disk unavailable');},execute:()=>{executions++;return failedCommand();}}),7);
  assert.equal(executions,1);
});
