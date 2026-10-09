import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { committedPactFiles, pactProvider, verifiedProviders } from './support/pact-files';
import { verifyPact } from './support/provider';

test('a provider that breaks a contract fails verification', async () => {
  const [pactFile] = committedPactFiles();
  const pact = JSON.parse(fs.readFileSync(pactFile, 'utf8'));
  const [first] = pact.interactions;
  first.response.status = first.response.status === 200 ? 418 : 200;
  const brokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solventa-pact-')), path.basename(pactFile));
  fs.writeFileSync(brokenFile, JSON.stringify(pact));
  await assert.rejects(verifyPact(brokenFile));
});

test('every committed pact targets a provider that has a verification', () => {
  for (const file of committedPactFiles()) {
    assert.ok(verifiedProviders.includes(pactProvider(file)), `${path.basename(file)} targets ${pactProvider(file)}, which has no provider verification`);
  }
});
