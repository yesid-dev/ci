import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function bashExecutable() {
  if(process.env.ETA_BASH)return process.env.ETA_BASH;
  if(process.platform!=='win32')return 'bash';
  const gitCore=execFileSync('git',['--exec-path'],{encoding:'utf8'}).trim();
  return resolve(gitCore,'../../..','bin/bash.exe');
}

const preload=`globalThis.fetch=async url=>{
  if(process.env.ETA_TEST_API==='unavailable')return new Response('{}',{status:403});
  const job={id:123,run_id:10,run_attempt:1,name:'test',status:'queued',started_at:'2026-11-10T00:00:00Z'};
  const path=new URL(url).pathname;
  const body=path.endsWith('/actions/jobs/123')?job:path.endsWith('/actions/runs/10')?{id:10,workflow_id:3}:{workflow_runs:[]};
  return new Response(JSON.stringify(body),{status:200});
};`;

test('actual Bash/CLI runs the command and preserves exit codes even when ETA is unavailable',async t=>{
  const scenarios=[
    {name:'queued metadata, exit 7',exit:7,api:'queued'},
    {name:'unavailable API, exit 7',exit:7,api:'unavailable'},
    {name:'unavailable API, exit 42',exit:42,api:'unavailable'},
    {name:'unavailable API, success',exit:0,api:'unavailable'},
    {name:'unavailable API, pipeline fails',exit:0,api:'unavailable',suffix:'; false | true',expected:1}
  ];
  for(const scenario of scenarios)await t.test(scenario.name,()=>{
    const dir=mkdtempSync(join(tmpdir(),'eta-cli-'));
    const files=['preload.mjs','command.mjs','executed','summary.md'];
    try {
      writeFileSync(join(dir,'preload.mjs'),preload);
      writeFileSync(join(dir,'command.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync(process.env.ETA_TEST_MARKER,'executed');process.exit(Number(process.env.ETA_TEST_EXIT));");
      const result=spawnSync(process.execPath,['--import',pathToFileURL(join(dir,'preload.mjs')).href,fileURLToPath(new URL('../actions/eta/eta.mjs',import.meta.url))],{
        encoding:'utf8',timeout:10000,
        env:{...process.env,GH_TOKEN:'test-fixture',GITHUB_REPOSITORY:'org/ci',GITHUB_RUN_ID:'10',GITHUB_RUN_ATTEMPT:'1',
          ETA_CHECK_RUN_ID:'123',ETA_JOB_NAME:'test',ETA_BASH:bashExecutable(),
          ETA_COMMAND:'"$ETA_TEST_NODE" "$ETA_TEST_SCRIPT"'+(scenario.suffix??''),
          ETA_TEST_NODE:process.execPath,ETA_TEST_SCRIPT:join(dir,'command.mjs'),ETA_TEST_MARKER:join(dir,'executed'),ETA_TEST_EXIT:String(scenario.exit),
          ETA_TEST_API:scenario.api,GITHUB_STEP_SUMMARY:join(dir,'summary.md')}
      });
      assert.ifError(result.error);
      assert.equal(result.status,scenario.expected??scenario.exit,result.stderr);
      assert.equal(readFileSync(join(dir,'executed'),'utf8'),'executed');
      assert.match(readFileSync(join(dir,'summary.md'),'utf8'),/^Expected finish: unavailable \(.+\)\.\n$/);
    } finally {
      // Remove only the known files inside the directory this test just created.
      assert.equal(dirname(dir),resolve(tmpdir()));
      for(const file of files)if(existsSync(join(dir,file)))unlinkSync(join(dir,file));
      rmdirSync(dir);
    }
  });
});
