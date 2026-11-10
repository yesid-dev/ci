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

async function main() {
  const name=process.env.ETA_JOB_NAME;
  if(!name || !process.env.ETA_COMMAND || !process.env.ETA_BASH) throw new Error('Require job-name, command and Bash executable');
  const currentRun=await api('actions/runs/'+process.env.GITHUB_RUN_ID);
  const current=(await pages('actions/runs/'+currentRun.id+'/jobs?filter=latest','jobs')).filter(j=>j.name===name && j.status==='in_progress');
  if(current.length!==1)throw new Error('Expected exactly one running job named '+name);
  const samples=await samplesFor(currentRun.workflow_id,name,currentRun.id);
  let deadline=null;
  if(!samples.length) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,'Expected finish: unavailable (no successful main job samples).\n');
  } else {
    const start=Date.parse(current[0].started_at);
    if(!Number.isFinite(start))throw new Error('Invalid current job start time');
    const p50=percentile(samples,.5); const p90=percentile(samples,.9);
    deadline=start+p90;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,'Expected finish: p50 '+new Date(start+p50).toISOString()+'; p90 '+new Date(deadline).toISOString()+' ('+samples.length+' successful main jobs).\n');
  }
  process.exitCode=await runCommand({executable:process.env.ETA_BASH,args:['--noprofile','--norc','-e','-o','pipefail','-c',process.env.ETA_COMMAND],deadline});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
