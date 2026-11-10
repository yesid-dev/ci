import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function desiredRuleset(template, config) {
  if (!Number.isInteger(config.rulesetId) || config.rulesetId < 1) throw new Error('Missing live ruleset ID');
  if (!Array.isArray(config.requiredChecks) || !config.requiredChecks.length || config.requiredChecks.some(c => !c.context || typeof c.context !== 'string')) throw new Error('Required checks must be nonempty');
  if (!Number.isInteger(config.checkTimeoutMinutes) || config.checkTimeoutMinutes < 1 || config.checkTimeoutMinutes > 60) throw new Error('Invalid check timeout');
  const result = structuredClone(template);
  result.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks = config.requiredChecks;
  result.rules.find(r => r.type === 'merge_queue').parameters.check_response_timeout_minutes = config.checkTimeoutMinutes;
  return result;
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function writable(value) {
  return Object.fromEntries(['name','target','enforcement','conditions','bypass_actors','rules'].map(k => [k,value[k]]));
}
const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function run(mode, repo, template, configs, api) {
  if (!['diff','apply'].includes(mode) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Object.hasOwn(configs,repo)) throw new Error('Usage: node scripts/rulesets.mjs diff|apply owner/repo (configured repository only)');
  const config = configs[repo]; const desired = desiredRuleset(template,config);
  const endpoint = 'repos/' + repo + '/rulesets/' + config.rulesetId;
  const current = writable(api('GET',endpoint));
  if (current.target !== 'branch' || !equal(current.conditions,template.conditions)) throw new Error('Refusing to replace a ruleset outside main');
  const changed = !equal(current,desired);
  if (mode === 'apply' && changed) {
    api('PUT',endpoint,desired);
    if (!equal(writable(api('GET',endpoint)),desired)) throw new Error('Applied ruleset readback differs');
  }
  return {repository:repo,changed,current,desired};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [template,configs] = await Promise.all(['main','repos'].map(n => readFile(new URL('../rulesets/'+n+'.json',import.meta.url),'utf8').then(JSON.parse)));
    const api = (method,endpoint,body) => JSON.parse(execFileSync('gh',['api','--method',method,endpoint,...(body?['--input','-']:[])],{encoding:'utf8',input:body?JSON.stringify(body):undefined}));
    console.log(JSON.stringify(run(process.argv[2],process.argv[3],template,configs,api),null,2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
