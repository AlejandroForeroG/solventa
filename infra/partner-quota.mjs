import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const fail=code=>Object.assign(Error(code),{code});
export function validatePartnerQuotaInput(environment,input) {
  if(!['local','dev','staging','prod'].includes(environment)||!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).length!==3||!uuid(input.partnerId)||!uuid(input.operatorReference)
    ||!Number.isSafeInteger(input.dailyLimit)||input.dailyLimit<1||input.dailyLimit>1000000000) throw fail('invalid_input');
  return {partnerId:input.partnerId.toLowerCase(),operatorReference:input.operatorReference.toLowerCase(),dailyLimit:input.dailyLimit};
}
// Administrative credentials authorize changes. The operator UUID is audit attribution, never a credential.
export async function changePartnerQuota(db,environment,input) {
  const setting=validatePartnerQuotaInput(environment,input);
  await db.query('BEGIN');
  try {
    if(!(await db.query("SELECT id FROM identity.partners WHERE id=$1 AND status='active' FOR UPDATE",[setting.partnerId])).rowCount) throw fail('partner_inactive_or_missing');
    const old=(await db.query(`SELECT coalesce(o.daily_limit,p.daily_limit)::STRING AS daily_limit FROM identity.partner_quota_policy p
      LEFT JOIN identity.partner_quota_overrides o ON o.partner_id=$1 WHERE p.id=true`,[setting.partnerId])).rows[0];
    if(!old) throw fail('quota_configuration_unavailable');
    const changed=Number(old.daily_limit)!==setting.dailyLimit;
    if(changed) {
      await db.query(`INSERT INTO identity.partner_quota_overrides(partner_id,daily_limit,updated_by) VALUES($1,$2,$3)
        ON CONFLICT(partner_id) DO UPDATE SET daily_limit=excluded.daily_limit,updated_at=clock_timestamp(),updated_by=excluded.updated_by`,[setting.partnerId,setting.dailyLimit,setting.operatorReference]);
      await db.query(`INSERT INTO identity.audit_events(actor_reference,action,resource_type,resource_id,outcome,correlation_id,retention_until)
        VALUES($1,'partner_quota.changed','partner_quota',$2,$3,$4,now()+interval '90 days')`,[setting.operatorReference,setting.partnerId,
        JSON.stringify({previousLimit:Number(old.daily_limit),dailyLimit:setting.dailyLimit}),randomUUID()]);
    }
    await db.query('COMMIT');return {status:'passed',environment,partnerId:setting.partnerId,dailyLimit:setting.dailyLimit,changed};
  } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;}
}
async function main() {
  const [environment,path,...extra]=process.argv.slice(2);
  if(!path||extra.length||(await stat(path)).size>1024) throw fail('invalid_command');
  const input=validatePartnerQuotaInput(environment,JSON.parse(await readFile(path,'utf8')));
  const {settings,clientFor}=await import('./database.mjs');const config=await settings(environment);
  const url=new URL(config.url);url.pathname='/'+config.database;const db=clientFor(url,config.ssl);
  try {
    await db.connect();const who=(await db.query('SELECT current_database() AS database,current_user AS role')).rows[0];
    if(who.database!==config.database||/^solventa_(local|dev|staging|prod)_/.test(who.role)) throw fail('administrative_connection_required');
    console.log(JSON.stringify(await changePartnerQuota(db,environment,input)));
  } finally {await db.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error(JSON.stringify({status:'failed',code:/^[a-z_]{3,64}$/.test(error.code??'')?error.code:'quota_change_failed'}));process.exitCode=1;
});
