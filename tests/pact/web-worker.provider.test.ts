import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { committedPactFiles } from './support/pact-files';
import { verifyPact } from './support/provider';

const pactFiles = committedPactFiles();

test('there are committed pacts to verify', () => assert.ok(pactFiles.length > 0));

for (const pactFile of pactFiles) {
  test(`web Worker satisfies ${path.basename(pactFile)}`, () => verifyPact(pactFile));
}
