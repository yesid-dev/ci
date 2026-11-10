import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { api } from '../api.mjs';
export async function awaitArtifact({name,timeoutSeconds,intervalSeconds=5,request=api,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  if(!name || !Number.isInteger(timeoutSeconds) || timeoutSeconds<1 || timeoutSeconds>3600 || !Number.isInteger(intervalSeconds) || intervalSeconds<1 || intervalSeconds>60) throw new Error('Require artifact name, timeout 1..3600s and interval 1..60s');
  const deadline=now()+timeoutSeconds*1000;
  while(now()<deadline) {
    for(let page=1;;page++) {
      const remaining=deadline-now(); if(remaining<=0)break;
      const data=await request('actions/runs/'+process.env.GITHUB_RUN_ID+'/artifacts?per_page=100&page='+page,{signal:AbortSignal.timeout(Math.max(1,remaining))});
      if(now()>=deadline)break;
      const artifact=data.artifacts.find(a=>a.name===name&&!a.expired);
      if(artifact)return artifact;
      if(data.artifacts.length<100)break;
    }
    if(now()<deadline)await sleep(Math.min(intervalSeconds*1000,deadline-now()));
  }
  throw new Error('Artifact "'+name+'" was not available in this run within '+timeoutSeconds+' seconds');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const artifact=await awaitArtifact({name:process.env.ARTIFACT_NAME,timeoutSeconds:Number(process.env.ARTIFACT_TIMEOUT),intervalSeconds:Number(process.env.ARTIFACT_INTERVAL)});
    appendFileSync(process.env.GITHUB_OUTPUT,'artifact-id='+artifact.id+'\n');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
