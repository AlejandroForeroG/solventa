import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Execute from the repository root against a disposable database with real runtime grants.
const root=process.cwd().replaceAll('\\','/');
const output=process.env.PARTNER_PORTAL_SQL_OUTPUT ?? 'infra/.local/partner-portal-tests';
await mkdir(output,{recursive:true});
const fromProduct=(path: string)=>import(pathToFileURL(root+'/'+path).href);
const { settings,clientFor,owners,applyMigrations,applyRuntimeGrants }=await fromProduct('infra/database.mjs');
const { SqlPartnerPortal }=await fromProduct('backend/acquisition-risk/src/adapters/outbound/sql-partner-portal.ts');
const { PartnerPortal }=await fromProduct('backend/acquisition-risk/src/application/partner-portal.ts');
const { SqlPartnerPortalGrants }=await fromProduct('backend/identity-consent-ecosystem/src/adapters/outbound/partner-portal-grants.ts');
const { changePartnerPortalGrant }=await fromProduct('infra/partner-portal-access.mjs');
const { isPortalData }=await fromProduct('apps/web/src/partner-portal/api.ts');
const { mountPartnerPortal }=await fromProduct('backend/acquisition-risk/src/adapters/inbound/partner-portal-http.ts');
const { Hono }=createRequire(root+'/package.json')('hono');
const sha=value=>createHash('sha256').update(value).digest('hex');
const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID();
const path=output+'/smoke-sql-'+runId+'.json';
const name='solventa_portal_smoke_'+randomUUID().replaceAll('-','');
assert.match(name,/^solventa_portal_smoke_[a-f0-9]{32}$/);
const observedFiles=['backend/acquisition-risk/src/adapters/outbound/sql-partner-portal.ts','backend/identity-consent-ecosystem/src/adapters/outbound/partner-portal-grants.ts','infra/partner-portal-access.mjs','apps/web/src/partner-portal/api.ts'];
const hashes=Object.fromEntries(await Promise.all(observedFiles.map(async file=>[file,sha(await readFile(root+'/'+file))])));
const receipt={runId,startedAt:new Date().toISOString(),database:name,environment:'local',scriptSha256:sha(await readFile(new URL(import.meta.url))),sourceHashes:hashes,
  fixture:'Explicit synthetic SQL fixtures for portal query semantics; no claim of commercial acquisition journey, real WorkOS authentication or external provider execution',
  status:'running',cleanup:'not_created',checks:[],limits:['Synthetic fixtures; HTTP authorization collaborator is replaced; SQL grant repository and operator are real']};
let admin,db,acquisition,identity,created=false,complete=false,stage='configuration';
const check=label=>receipt.checks.push(label);
try {
  const config=await settings('local'); assert.equal(config.database,'solventa_local'); assert.equal(config.ssl.rejectUnauthorized,true);
  const held=JSON.parse(await readFile(root+'/infra/.local/runtime.local.json','utf8')); assert.equal(held.database,'solventa_local');
  admin=clientFor(config.url,config.ssl); await admin.connect();
  const users=(await admin.query('SHOW USERS')).rows;
  for(const schema of ['identity','acquisition']) assert.ok(users.some(user=>user.username==='solventa_local_'+schema));
  stage='database_and_migrations';
  await admin.query(`CREATE DATABASE ${name}`); created=true; receipt.cleanup='pending';
  const url=new URL(config.url); url.pathname='/'+name; db=clientFor(url,config.ssl); await db.connect();
  await db.query(`REVOKE ALL ON DATABASE ${name} FROM public`); await db.query('REVOKE ALL ON SCHEMA public FROM public');
  for(const schema of ['identity','acquisition']) {
    const owner=owners.find(value=>value.schema===schema); assert.ok(owner);
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`REVOKE ALL ON SCHEMA ${schema} FROM public`);
    await db.query(`CREATE TABLE ${schema}.schema_migrations(version STRING PRIMARY KEY,checksum STRING NOT NULL,applied_at TIMESTAMPTZ DEFAULT now())`);
    const migrations=await Promise.all((await readdir(root+'/backend/'+owner.name+'/migrations')).filter(file=>file.endsWith('.sql')).sort().map(async version=>({version,sql:await readFile(root+'/backend/'+owner.name+'/migrations/'+version,'utf8')})));
    await applyMigrations(db,owner,migrations); await applyMigrations(db,owner,migrations);
    await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_${schema}`);
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO solventa_local_${schema}`);
    await applyRuntimeGrants(db,owner,'solventa_local_'+schema,JSON.parse(await readFile(root+'/backend/'+owner.name+'/runtime-grants.json','utf8')));
  }
  complete=true; check('complete_identity_and_acquisition_migrations_replay_and_real_runtime_grants');
  const runtime=schema=>{const value=new URL(url); value.username='solventa_local_'+schema; value.password=held.passwords[schema]; value.searchParams.set('sslmode','verify-full'); value.searchParams.set('sslrootcert',root+'/infra/.local/certs/ca.crt'); return value;};
  acquisition=clientFor(runtime('acquisition'),config.ssl); identity=clientFor(runtime('identity'),config.ssl); await acquisition.connect(); await identity.connect();
  await assert.rejects(acquisition.query('SELECT id FROM identity.partners LIMIT 1'),error=>error.code==='42501');
  await assert.rejects(identity.query('SELECT id FROM acquisition.quotes LIMIT 1'),error=>error.code==='42501');
  await assert.rejects(identity.query('INSERT INTO identity.partner_portal_grants DEFAULT VALUES'),error=>error.code==='42501');
  check('owners_cannot_cross_schemas_and_identity_runtime_cannot_self_grant');
  const a=randomUUID(),b=randomUUID(),client=randomUUID(),subject=randomUUID(),op=randomUUID();
  const seedQuote=async(partner,instant)=>{
    const id=randomUUID();
    await db.query(`INSERT INTO acquisition.quotes(id,subject_token,partner_id,client_id,idempotency_key,request_hash,normalized_request,rule_version,result,status,correlation_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-portal-rule',$8,'completed',$9,$10)`,
      [id,subject,partner,partner?null:client,randomUUID(),'a'.repeat(64),JSON.stringify({privateMarker:'do-not-project'}),'{}',randomUUID(),instant]);
    return id;
  };
  const seedDecision=async(partner,outcome,quote,instant)=>{
    const id=randomUUID();
    await db.query(`INSERT INTO acquisition.underwriting_decisions(id,quote_id,rule_version,contract_version,outcome,explanation,input_snapshot,correlation_id,decided_at)
      VALUES($1,$2,'synthetic-portal-rule','v1',$3,'{}',$4,$5,$6)`,[id,quote,outcome,JSON.stringify({privateMarker:'do-not-project',...(partner?{channel:{kind:'partner',partnerId:partner,authorizationId:randomUUID()}}:{})}),randomUUID(),instant]);
    return id;
  };
  stage='synthetic_facts';
  for(let i=0;i<25;i++) await seedQuote(a,`2026-11-10T12:00:${String(i).padStart(2,'0')}.000Z`);
  await seedQuote(a,'2026-11-09T23:59:59.999Z'); await seedQuote(a,'2026-11-10T00:00:00.000Z');
  await seedQuote(a,'2026-11-10T23:59:59.999Z'); await seedQuote(a,'2026-11-11T00:00:00.000Z');
  await seedQuote(b,'2026-11-10T12:00:00.000Z'); await seedQuote(b,'2026-11-10T12:00:01.000Z');
  const inner=await seedQuote(null,'2026-11-10T13:00:00.000Z');
  for(const outcome of ['accepted','preliminary','declined']) await seedDecision(a,outcome,inner,'2026-11-10T14:00:00.000Z');
  await seedDecision(b,'accepted',inner,'2026-11-10T14:00:00.000Z'); await seedDecision(null,'accepted',inner,'2026-11-10T14:00:00.000Z');
  const store=new SqlPartnerPortal(runtime('acquisition').toString());
  stage='portal_query';
  const query={from:'2026-11-10',to:'2026-11-10'};
  const result=await store.read(a,query);
  assert.deepEqual(result.totals,{completed:27,accepted:1,preliminary:1,declined:1});
  assert.equal(result.items.length,20); assert.equal(result.hasMore,true);
  assert.ok(result.items.every(item=>Date.parse(item.occurredAt)>=Date.parse('2026-11-10T00:00:00Z')&&Date.parse(item.occurredAt)<Date.parse('2026-11-11T00:00:00Z')));
  assert.equal(result.items.filter(item=>item.kind==='offer_decision').length,3);
  assert.equal(result.items.some(item=>item.id===inner),false);
  assert.equal(JSON.stringify(result).includes('do-not-project'),false); assert.equal(JSON.stringify(result).includes(subject),false);
  const other=await store.read(b,query); assert.deepEqual(other.totals,{completed:2,accepted:1,preliminary:0,declined:0});
  assert.equal(other.items.length,3); assert.equal(other.hasMore,false);
  check('partner_A_B_isolation_channel_attribution_no_inner_quote_duplication_and_safe_projection');
  check('all_30_period_facts_counted_while_recent_list_is_20_with_hasMore');
  check('UTC_start_included_end_midnight_excluded_and_last_millisecond_included');
  const empty=await store.read(a,{from:'2026-11-01',to:'2026-11-01'});
  assert.deepEqual(empty.totals,{completed:0,accepted:0,preliminary:0,declined:0}); assert.deepEqual(empty.items,[]); assert.equal(empty.hasMore,false);
  check('empty_period_is_real_zero_and_empty_list');
  stage='identity_grant_operator';
  const now=Date.now(),expiresAt=new Date(now+3600000).toISOString(), grantId=randomUUID(), providerSubject='synthetic-user-'+randomUUID(),sessionReference='synthetic-session-'+randomUUID();
  await db.query("INSERT INTO identity.clients(id,subject_token) VALUES($1,$2)",[client,subject]);
  await db.query("INSERT INTO identity.partners(id,code) VALUES($1,'synthetic-a'),($2,'synthetic-b')",[a,b]);
  await db.query("INSERT INTO identity.external_identities(client_id,provider,provider_subject) VALUES($1,'workos',$2)",[client,providerSubject]);
  await db.query("INSERT INTO identity.authentication_sessions(client_id,provider,provider_session,expires_at) VALUES($1,'workos',$2,$3)",[client,sessionReference,expiresAt]);
  const grant={grantId,clientId:client,partnerId:a,expiresAt,operatorReference:op};
  stage='operator_first_grant';
  assert.equal((await changePartnerPortalGrant(db,'local','grant',grant)).changed,true);
  assert.equal((await changePartnerPortalGrant(db,'local','grant',grant)).changed,false);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM identity.audit_events WHERE resource_id=$1 AND action='partner_portal_grant.grant'",[grantId])).rows[0].n,1);
  const repo=new SqlPartnerPortalGrants(runtime('identity').toString()), principal={clientId:client,subjectToken:subject}, verified={providerSubject,sessionReference,emailVerified:true};
  stage='grant_repository_first_find';
  let access=await repo.find(principal,verified); assert.equal(access.partnerId,a);
  assert.ok(Date.parse(access.expiresAt)>Date.now()&&Date.parse(access.expiresAt)<=Date.now()+5500);
  assert.equal(await repo.find({...principal,subjectToken:randomUUID()},verified),null);
  assert.equal(await repo.find(principal,{...verified,sessionReference:'other-session'}),null);
  check('real_grant_operator_replay_is_idempotent_and_grant_repository_binds_client_subject_and_session');
  stage='suspended_principals';
  for(const [suspend,restore]of [
    ["UPDATE identity.clients SET status='suspended' WHERE id=$1","UPDATE identity.clients SET status='active' WHERE id=$1"],
    ["UPDATE identity.partners SET status='suspended' WHERE id=$1","UPDATE identity.partners SET status='active' WHERE id=$1"],
    ['UPDATE identity.authentication_sessions SET revoked_at=now() WHERE client_id=$1','UPDATE identity.authentication_sessions SET revoked_at=NULL WHERE client_id=$1']
  ]) {
    const target=suspend.includes('identity.partners')?a:client;
    await db.query(suspend,[target]);try{assert.equal(await repo.find(principal,verified),null);}finally{await db.query(restore,[target]);}
  }
  check('suspended_client_suspended_partner_and_revoked_session_each_deny_real_repository');
  stage='operator_audit_rollback';
  const badAudit={query:(text,params)=>db.query(typeof text==='string'&&text.includes('INSERT INTO identity.audit_events')?text.replace("INTERVAL '90 days'","INTERVAL '-1 day'"):text,params)};
  const rollbackClient=randomUUID(),rollbackGrant=randomUUID();
  await db.query('INSERT INTO identity.clients(id,subject_token) VALUES($1,$2)',[rollbackClient,randomUUID()]);
  await assert.rejects(changePartnerPortalGrant(badAudit,'local','grant',{...grant,grantId:rollbackGrant,clientId:rollbackClient}),error=>error.code==='23514');
  assert.equal((await db.query('SELECT id FROM identity.partner_portal_grants WHERE id=$1',[rollbackGrant])).rowCount,0);
  await assert.rejects(changePartnerPortalGrant(badAudit,'local','revoke',{grantId,operatorReference:op}),error=>error.code==='23514');
  assert.equal((await db.query('SELECT revoked_at FROM identity.partner_portal_grants WHERE id=$1',[grantId])).rows[0].revoked_at,null);
  assert.equal((await repo.find(principal,verified)).partnerId,a);
  check('grant_and_revoke_roll_back_atomically_when_real_audit_retention_constraint_fails');
  for(let i=0;i<22;i++) await db.query(`INSERT INTO identity.partner_credentials(partner_id,provider,credential_reference,scopes,expires_at,created_at,revoked_at)
    VALUES($1,'synthetic-provider',$2,ARRAY['quotes:create'],$3,$4,$5)`,[a,'private-credential-reference-'+i,new Date(now+(i===0?-3600000:3600000)).toISOString(),new Date(now-7200000-i*1000).toISOString(),i===1?new Date(now-1800000).toISOString():null]);
  await db.query("INSERT INTO identity.partner_credentials(partner_id,provider,credential_reference,scopes,expires_at) VALUES($1,'synthetic-provider','other-partner-private',ARRAY['quotes:create'],$2)",[b,expiresAt]);
  access=await repo.find(principal,verified); assert.equal(access.credentials.length,20); assert.equal(access.hasMoreCredentials,true);
  assert.deepEqual(new Set(access.credentials.map(value=>value.status)),new Set(['active','expired','revoked']));
  assert.equal(JSON.stringify(access).includes('credential_reference'),false); assert.equal(JSON.stringify(access).includes('private-credential'),false);
  check('credential_projection_caps_20_flags_more_excludes_raw_references_and_retains_all_three_real_states');
  const response={traceId:randomUUID(),partner:{id:a,code:'synthetic-a'},credentials:access.credentials,hasMoreCredentials:access.hasMoreCredentials,
    quota:{configured:false},catalog:[{product:'vida_hipotecario',operations:[{method:'POST',path:'/api/v1/quotes',scope:'quotes:create'}]}],versions:[{id:'v1'}],period:{...query,timeZone:'UTC'},...result};
  assert.equal(isPortalData(response),true); check('real_SQL_JSON_timestamps_credentials_and_transactions_pass_web_consumer_validator');
  stage='unavailability';
  await db.query('ALTER TABLE acquisition.quotes RENAME TO quotes_unavailable_probe');
  try {
    await assert.rejects(store.read(a,query));
    const app=new Hono(); mountPartnerPortal(app,{portal:new PartnerPortal(store),versions:[{id:'v1'}],authorize:async()=>{
      const fresh=await repo.find(principal,verified); return {allowed:true,actor:{kind:'user',channel:'web',principal,operations:['partner-portal:read'],authorizationExpiresAt:fresh.expiresAt,partnerPortal:fresh}};
    }});
    const failed=await app.request('http://localhost:8787/api/v1/partner-portal?from=2026-11-10&to=2026-11-10',{}, {APP_ENV:'local'});
    assert.equal(failed.status,503); const body=await failed.json(); assert.equal(body.error,'portal_unavailable'); assert.equal('totals' in body,false);
  } finally {await db.query('ALTER TABLE acquisition.quotes_unavailable_probe RENAME TO quotes');}
  check('real_SQL_unavailability_rejects_and_HTTP_returns_503_without_fabricated_zero_metrics');
  stage='revocation';
  assert.equal((await changePartnerPortalGrant(db,'local','revoke',{grantId,operatorReference:op})).changed,true);
  assert.equal((await changePartnerPortalGrant(db,'local','revoke',{grantId,operatorReference:op})).changed,false);
  assert.equal(await repo.find(principal,verified),null);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM identity.audit_events WHERE resource_id=$1 AND action='partner_portal_grant.revoke'",[grantId])).rows[0].n,1);
  check('real_grant_revocation_takes_effect_and_replay_adds_no_audit');
  receipt.status='passed'; receipt.observed={totalsA:result.totals,recentA:result.items.length,hasMoreA:result.hasMore,totalsB:other.totals,empty:empty.totals};
} catch(error) {receipt.status='failed';receipt.failure={stage,code:error?.code??'assertion_or_execution_failure',migration:error?.migration,message:['ERR_ASSERTION','42803','XXUUU'].includes(error?.code)?String(error.message).slice(0,500):undefined};process.exitCode=1;}
finally {
  await acquisition?.end().catch(()=>{});await identity?.end().catch(()=>{});await db?.end().catch(()=>{});
  try {if(created&&complete){assert.match(name,/^solventa_portal_smoke_[a-f0-9]{32}$/);await admin.query(`DROP DATABASE ${name} CASCADE`);assert.equal((await admin.query('SELECT database_name FROM [SHOW DATABASES] WHERE database_name=$1',[name])).rowCount,0);receipt.cleanup='generated_database_dropped_and_absence_verified';}
    else if(created){receipt.cleanup='preserved_for_migration_reconciliation';process.exitCode=1;}}
  catch(error){receipt.cleanup='cleanup_failed_or_unverified';receipt.cleanupCode=error?.code;process.exitCode=1;}finally{await admin?.end().catch(()=>{});}
  receipt.sourcesChangedDuringRun=[];for(const[file,hash]of Object.entries(hashes))if(sha(await readFile(root+'/'+file))!==hash)receipt.sourcesChangedDuringRun.push(file);
  receipt.finishedAt=new Date().toISOString();await writeFile(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  await writeFile(output+'/smoke-sql-latest.json',JSON.stringify({receipt:path,status:receipt.status,cleanup:receipt.cleanup},null,2)+'\n');
  console.log(JSON.stringify({portalSmokeSQL:receipt.status,checks:receipt.checks.length,cleanup:receipt.cleanup,receipt:path,failure:receipt.failure}));
}
