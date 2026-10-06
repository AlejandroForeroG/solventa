import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function localToken() {
  const path = 'apps/web/.dev.vars';
  try {
    const contents = await readFile(path, 'utf8');
    const token = contents.match(/^DEV_INFRA_TOKEN=([a-f0-9]{64})$/m)?.[1];
    if (!token) throw Error('Invalid local development token');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    await writeFile(path, `DEV_INFRA_TOKEN=${token}\n`, { mode: 0o600 });
    return token;
  }
}
