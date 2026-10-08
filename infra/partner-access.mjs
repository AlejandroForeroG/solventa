import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const environments = ['local', 'dev', 'staging', 'prod'];
const actions = ['register', 'revoke'];
function failure(code) { return Object.assign(Error(code), { code }); }
function boundedString(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }

export function validatePartnerAccessInput(environment, action, input, now = Date.now()) {
  if (!environments.includes(environment) || !actions.includes(action)) throw failure('invalid_command');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_input');
  const keys = action === 'register' ? ['partnerCode', 'provider', 'reference', 'scopes', 'expiresAt'] : ['provider', 'reference'];
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw failure('invalid_input');
  if (!['workos-connect', 'solventa-web'].includes(input.provider) || !boundedString(input.reference, 2048)) throw failure('invalid_reference');
  if (input.provider === 'solventa-web') {
    if (input.reference !== environment) throw failure('invalid_reference');
  } else {
    let tuple;
    try { tuple = JSON.parse(input.reference); } catch { throw failure('invalid_reference'); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || !boundedString(tuple[0], 512) || !boundedString(tuple[1], 256) || !boundedString(tuple[2], 256)) throw failure('invalid_reference');
    let issuer;
    try { issuer = new URL(tuple[0]); } catch { throw failure('invalid_reference'); }
    if (issuer.protocol !== 'https:' || !/^[a-z0-9-]+\.authkit\.app$/.test(issuer.hostname) || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash || issuer.pathname !== '/' || tuple[0] !== issuer.origin) throw failure('invalid_reference');
    if (!/^org_[a-zA-Z0-9]+$/.test(tuple[1]) || !/^client_[a-zA-Z0-9]+$/.test(tuple[2])) throw failure('invalid_reference');
    if (input.reference !== JSON.stringify(tuple)) throw failure('invalid_reference');
  }
  if (action === 'register') {
    if (typeof input.partnerCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.partnerCode)) throw failure('invalid_partner_code');
    if (!Array.isArray(input.scopes) || input.scopes.length !== 1 || input.scopes[0] !== 'quotes:create') throw failure('invalid_scopes');
    if (typeof input.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.expiresAt)) throw failure('invalid_expiry');
    const expires = new Date(input.expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= now || expires.toISOString() !== input.expiresAt.replace(/(?<!\.\d{3})Z$/, '.000Z')) throw failure('invalid_expiry');
  }
  return input;
}

// The caller supplies the owner's connected runtime client; no administrative SQL is needed.
export async function changePartnerAccess(db, environment, action, input) {
  validatePartnerAccessInput(environment, action, input);
  await db.query('BEGIN');
  try {
    let partnerId;
    let credentialId;
    let changed = true;
    if (action === 'register') {
      const existing = (await db.query('SELECT id FROM identity.partner_credentials WHERE provider=$1 AND credential_reference=$2', [input.provider, input.reference])).rows[0];
      if (existing) throw failure('credential_exists');
      let partner = (await db.query('SELECT id,status FROM identity.partners WHERE code=$1 FOR UPDATE', [input.partnerCode])).rows[0];
      if (!partner) partner = (await db.query('INSERT INTO identity.partners (code) VALUES ($1) RETURNING id,status', [input.partnerCode])).rows[0];
      if (partner.status !== 'active') throw failure('partner_inactive');
      partnerId = partner.id;
      credentialId = (await db.query(`INSERT INTO identity.partner_credentials (partner_id,provider,credential_reference,scopes,expires_at)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`, [partnerId, input.provider, input.reference, input.scopes, input.expiresAt])).rows[0].id;
    } else {
      const credential = (await db.query('SELECT id,partner_id,revoked_at FROM identity.partner_credentials WHERE provider=$1 AND credential_reference=$2 FOR UPDATE', [input.provider, input.reference])).rows[0];
      if (!credential) throw failure('credential_not_found');
      partnerId = credential.partner_id;
      credentialId = credential.id;
      changed = credential.revoked_at === null;
      if (changed) await db.query('UPDATE identity.partner_credentials SET revoked_at=now() WHERE id=$1', [credentialId]);
    }
    if (changed) await db.query(`INSERT INTO identity.audit_events (actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
      VALUES ($1,$2,'partner_credential',$3,'success',$4,now()+INTERVAL '90 days')`, [`partner-access-operator:${partnerId}`, `partner_credential.${action === 'register' ? 'registered' : 'revoked'}`, credentialId, randomUUID()]);
    await db.query('COMMIT');
    return { status: 'passed', environment, action, partnerId, credentialId, changed };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
}

async function main() {
  const [environment, action, inputPath, ...extra] = process.argv.slice(2);
  if (!environments.includes(environment) || !actions.includes(action) || !inputPath || extra.length) throw failure('invalid_command');
  if ((await stat(inputPath)).size > 16384) throw failure('invalid_input');
  const input = validatePartnerAccessInput(environment, action, JSON.parse(await readFile(inputPath, 'utf8')));
  const { settings, clientFor } = await import('./database.mjs');
  const config = await settings(environment);
  const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, 'utf8'));
  if (state.database !== config.database || !boundedString(state.passwords?.identity, 512)) throw failure('runtime_state_invalid');
  const url = new URL(config.url);
  url.pathname = '/' + config.database;
  url.username = `solventa_${environment}_identity`;
  url.password = state.passwords.identity;
  const db = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
  try { await db.connect(); console.log(JSON.stringify(await changePartnerAccess(db, environment, action, input))); }
  finally { await db.end().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const known = ['invalid_command', 'invalid_input', 'invalid_reference', 'invalid_partner_code', 'invalid_scopes', 'invalid_expiry', 'credential_exists', 'credential_not_found', 'partner_inactive', 'runtime_state_invalid'];
    console.error(JSON.stringify({ status: 'failed', code: known.includes(error.code) ? error.code : 'partner_access_failed' }));
    process.exitCode = 1;
  });
}
