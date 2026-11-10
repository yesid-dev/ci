export async function api(endpoint, {signal} = {}) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required (actions: read)');
  const response = await fetch('https://api.github.com/repos/'+process.env.GITHUB_REPOSITORY+'/'+endpoint, {headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:signal ?? AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('GitHub API '+response.status+' for '+endpoint);
  return response.json();
}
export async function pages(endpoint,key, request=api) {
  const results=[];
  for(let page=1;;page++) {
    const data=await request(endpoint+(endpoint.includes('?')?'&':'?')+'per_page=100&page='+page);
    results.push(...data[key]); if(data[key].length<100)return results;
  }
}
