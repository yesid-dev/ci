import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { api, pages } from '../api.mjs';
import { percentile, durations } from './stats.mjs';

export function runCommand({executable,args,deadline,warn=()=>console.log('::warning title=Job exceeds historical p90::Current elapsed time exceeds p90')}) {
  return new Promise((resolve,reject)=>{
    let timer;
    const child=spawn(executable,args,{stdio:'inherit'});
    if(deadline!==null && deadline!==undefined) {
      const remaining=deadline-Date.now();
      if(remaining<=0)warn();
      else timer=setTimeout(warn,remaining);
    }
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{
      clearTimeout(timer);
      if(signal)reject(new Error('Monitored command terminated by '+signal));
      else resolve(code);
    });
  });
}

export async function samplesFor(workflow,name,currentId,request=api,repository=process.env.GITHUB_REPOSITORY) {
  if(!repository)throw new Error('Owning repository is required for ETA history');
  const samples=[];
  for(let page=1;samples.length<20;page++) {
    const history=await request('actions/workflows/'+workflow+'/runs?branch=main&status=completed&per_page=100&page='+page);
    for(const run of history.workflow_runs) {
      if(run.id===currentId || run.head_branch!=='main' || run.head_repository?.full_name?.toLowerCase()!==repository.toLowerCase() || ['pull_request','pull_request_target'].includes(run.event))continue;
      const jobs=await pages('actions/runs/'+run.id+'/jobs?filter=latest','jobs',request);
      const matches=jobs.filter(j=>j.name===name);
      if(matches.length>1)throw new Error('Ambiguous historical job name '+name);
      samples.push(...durations(matches));
      if(samples.length===20)break;
    }
    if(history.workflow_runs.length<100)break;
  }
  return samples;
}

const unavailable=reason=>'Expected finish: unavailable ('+reason.replace(/[\r\n]/g,' ')+').\n';
const warnP90=()=>console.log('::warning title=Job exceeds historical p90::Current elapsed time exceeds p90');
const reportIdentity=({contextId,jobId,runId,attempt})=>console.log('ETA identity verified: job.check_run_id='+contextId+'; jobs API id='+jobId+'; run='+runId+'; attempt='+attempt);

function id(value,label) {
  if(!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(label+' unavailable or invalid');
  return Number(value);
}

async function estimate(env,request,identity) {
  const checkId=id(env.ETA_CHECK_RUN_ID,'job.check_run_id');
  const runId=id(env.GITHUB_RUN_ID,'run ID'); const attempt=id(env.GITHUB_RUN_ATTEMPT,'run attempt');
  const current=await request('actions/jobs/'+checkId);
  if(current.id!==checkId || current.run_id!==runId || current.run_attempt!==attempt) throw new Error('current job identity does not match this run attempt');
  identity({contextId:checkId,jobId:current.id,runId,attempt});
  if(!env.ETA_JOB_NAME || current.name!==env.ETA_JOB_NAME) throw new Error('configured job-name does not match current job');
  const start=Date.parse(current.started_at);
  if(!Number.isFinite(start))throw new Error('current job start time unavailable');
  const currentRun=await request('actions/runs/'+runId);
  if(currentRun.id!==runId || !Number.isSafeInteger(currentRun.workflow_id))throw new Error('workflow identity unavailable');
  const samples=await samplesFor(currentRun.workflow_id,current.name,runId,request,env.GITHUB_REPOSITORY);
  if(!samples.length)return {summary:unavailable('no successful main job samples'),deadline:null};
  const p50=percentile(samples,.5); const deadline=start+percentile(samples,.9);
  return {summary:'Expected finish: p50 '+new Date(start+p50).toISOString()+'; p90 '+new Date(deadline).toISOString()+' ('+samples.length+' successful main jobs).\n',deadline};
}

export async function runEta({env=process.env,request=api,writeSummary=text=>appendFileSync(env.GITHUB_STEP_SUMMARY,text),execute=runCommand,identity=reportIdentity,warn=warnP90}={}) {
  if(!env.ETA_COMMAND || !env.ETA_BASH)throw new Error('Require command and Bash executable');
  const controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]);
  let finished=false; let published=false; let timer;
  const publish=text=>{
    try {writeSummary(text);published=true;} catch {console.error('ETA summary could not be written');}
  };
  try {
    // Start the real command before any telemetry request. Only its result controls the exit code.
    const completion=execute({executable:env.ETA_BASH,args:['--noprofile','--norc','-e','-o','pipefail','-c',env.ETA_COMMAND],deadline:null});
    void estimate(env,(endpoint)=>request(endpoint,{signal}),identity).then(result=>{
      if(finished)return;
      publish(result.summary);
      if(result.deadline!==null) {
        const remaining=result.deadline-Date.now();
        if(remaining<=0)warn(); else timer=setTimeout(warn,remaining);
      }
    }).catch(error=>{
      if(!finished)publish(unavailable(error instanceof Error?error.message:'ETA metadata unavailable'));
    });
    return await completion;
  } finally {
    finished=true; clearTimeout(timer); controller.abort();
    if(!published)publish(unavailable('command completed before ETA metadata was available'));
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runEta().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
