export function percentile(values,p) {
  if (!values.length) return null;
  if (p<0 || p>1 || values.some(v=>!Number.isFinite(v)||v<0)) throw new Error('Invalid percentile sample');
  const sorted=[...values].sort((a,b)=>a-b); const index=(sorted.length-1)*p;
  const low=Math.floor(index); return sorted[low]+(sorted[Math.ceil(index)]-sorted[low])*(index-low);
}
export function durations(jobs) {
  return jobs.filter(j=>j.conclusion==='success').map(j=>Date.parse(j.completed_at)-Date.parse(j.started_at)).filter(n=>Number.isFinite(n)&&n>=0);
}
