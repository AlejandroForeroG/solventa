import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
test('deployment resolves only an environment branch before credentials', async () => {
  const workflow = await readFile('.github/workflows/deploy.yml','utf8');
  const block = workflow.split('name: Resolve environment branch')[1].split('  validate:')[0].split('run: |')[1];
  const guard = block.split('\n').filter(line=>line.trim()).map(line=>line.slice(10)).join('\n');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  for (const branch of ['dev','staging','prod','main','feat/login','codex/infra']) {
    const result = spawnSync(bash,['-c',guard],{env:{...process.env,GITHUB_REF_NAME:branch,GITHUB_OUTPUT:process.platform==='win32'?'NUL':'/dev/null'},encoding:'utf8',windowsHide:true});
    assert.equal(result.status===0,['dev','staging','prod'].includes(branch),branch);
  }
  assert.ok(!workflow.includes('workflow_dispatch'));
  assert.match(workflow,/needs: \[resolve, validate\]/);
});
