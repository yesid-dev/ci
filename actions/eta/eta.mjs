import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api, pages } from '../api.mjs';
import { percentile, durations } from './stats.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main() {
  if(process.argv[2]==='monitor') {
    const [jobId,deadline]=process.argv.slice(3).map(Number);
    while(Date.now()<deadline) await sleep(Math.min(15000,deadline-Date.now()));
    const job=await api('actions/jobs/'+jobId);
    if(job.status!=='completed') console.log('::warning title=Job exceeds historical p90::Expected finish p90 has passed for job '+jobId);
    return;
  }
  const name=process.env.ETA_JOB_NAME;
  if(!name) throw new Error('job-name must match the API job display name, including matrix values');
  const currentRun=await api('actions/runs/'+process.env.GITHUB_RUN_ID);
  const current=(await pages('actions/runs/'+currentRun.id+'/jobs?filter=latest','jobs')).filter(j=>j.name===name && j.status==='in_progress');
  if(current.length!==1) throw new Error('Expected exactly one running job named '+name);
  const workflow=currentRun.workflow_id;
  const samples=[];
  for(let page=1;samples.length<20;page++) {
    const history=await api('actions/workflows/'+workflow+'/runs?branch=main&status=completed&per_page=100&page='+page);
    for(const run of history.workflow_runs) {
    if(run.id===currentRun.id)continue;
    const jobs=await pages('actions/runs/'+run.id+'/jobs?filter=latest','jobs');
    const matches=jobs.filter(j=>j.name===name);
    if(matches.length>1)throw new Error('Ambiguous historical job name '+name);
    samples.push(...durations(matches)); if(samples.length===20)break;
    }
    if(history.workflow_runs.length<100)break;
  }
  if(!samples.length) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,'Expected finish: unavailable (no successful main job samples).\n'); return;
  }
  const start=Date.parse(current[0].started_at); const p50=percentile(samples,.5); const p90=percentile(samples,.9);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,'Expected finish: p50 '+new Date(start+p50).toISOString()+'; p90 '+new Date(start+p90).toISOString()+' ('+samples.length+' successful main jobs).\n');
  if(Date.now()>start+p90)console.log('::warning title=Job exceeds historical p90::Current elapsed time exceeds p90');
  else {const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'monitor',String(current[0].id),String(start+p90)],{detached:true,stdio:['ignore',1,2]});child.unref();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
