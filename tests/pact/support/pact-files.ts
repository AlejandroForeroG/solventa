import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const committedPactsDir = path.resolve(__dirname, '../../../packages/contracts/pacts');
export const providerName = 'solventa-web';
// Every provider with a verification test. A pact for any other provider fails the guard until it is added here.
export const verifiedProviders = [providerName];

const updating = process.env.PACT_UPDATE === 'true';

// Normal runs write to a temporary directory and compare with the committed
// pact; `npm run pact:update` writes the committed files directly.
export function pactOutputDir(): string {
  return updating ? committedPactsDir : fs.mkdtempSync(path.join(os.tmpdir(), 'solventa-pact-'));
}

export function pactProvider(file: string): string {
  return JSON.parse(fs.readFileSync(file, 'utf8')).provider.name;
}

export function committedPactFiles(provider?: string): string[] {
  return fs.readdirSync(committedPactsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(committedPactsDir, name))
    .filter(file => provider === undefined || pactProvider(file) === provider);
}

function readWithoutMetadata(file: string) {
  const { metadata: _metadata, ...pact } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return pact;
}

// `metadata` carries the Pact library version, which is not part of the contract.
export function assertMatchesCommitted(outputDir: string, fileName: string) {
  if (updating) return;
  const committed = path.join(committedPactsDir, fileName);
  assert.ok(fs.existsSync(committed), `Missing committed pact ${fileName}. Run npm run pact:update.`);
  assert.deepEqual(readWithoutMetadata(path.join(outputDir, fileName)), readWithoutMetadata(committed), `Pact ${fileName} is out of date. Run npm run pact:update.`);
}
