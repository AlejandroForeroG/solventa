import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');

// Owner SQL transport and the receiver are explicit collaborators. The actual
// producer entrypoint, leased publisher, HMAC check, Queue binding and RPC run.
const stateSource = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { HmacOfferIntegrity } from './backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
let settings = {}, event, ownedOffer, status = 'pending', queued = [], imported = [], committed = false, commitRequested = false, rpcAttempts = 0;
export default class extends WorkerEntrypoint {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/configure') {
      settings = await request.json(); status = settings.httpCase ? 'uncommitted' : 'pending'; queued = []; imported = []; committed = false; commitRequested = false; rpcAttempts = 0;
      const at = new Date().toISOString();
      event = await new HmacOfferIntegrity('b'.repeat(64)).sign({version:1,eventType:'offer.accepted',eventId:crypto.randomUUID(),environment:'local',synthetic:true,
        occurredAt:at,correlationId:crypto.randomUUID(),payload:{acceptanceId:crypto.randomUUID(),offerId:crypto.randomUUID(),offerVersion:1,
          clientId:crypto.randomUUID(),subjectToken:crypto.randomUUID(),product:'vida_hipotecario',premium:'10000.0000',currency:'COP',
          coverage:{kind:'mortgage_life',sumInsured:'100000000.0000'},effectiveFrom:at,effectiveUntil:'2027-10-27T00:00:00.000Z',
          expiresAt:new Date(Date.now()+900000).toISOString(),ruleVersion:'academic-mortgage-1',acceptedAt:at}});
      if (settings.tamper) event.payload.premium = '1.0000';
      const {acceptanceId,acceptedAt,...terms}=event.payload;
      ownedOffer={terms:{...terms,quoteId:'COT-2026-00001',synthetic:true,status:'definitive'},consentId:'CNS-2026-00001',consentVersion:1};
      ownedOffer.seal=await new HmacOfferIntegrity('b'.repeat(64)).seal(ownedOffer.terms,ownedOffer);
    }
    if (path === '/release') settings.blockRpc = false;
    if (path === '/release-commit') settings.blockCommit = false;
    if (path === '/release-queue') settings.blockQueueClaim = false;
    return Response.json({ event, ownedOffer, status, queued, imported, committed, commitRequested, rpcAttempts });
  }
  async offer() {return ownedOffer;}
  async authorize(input) {return {allowed:true,actor:{kind:'user',channel:'web',principal:{clientId:ownedOffer.terms.clientId,subjectToken:ownedOffer.terms.subjectToken},operations:[input.operation]},
    consent:{consentId:ownedOffer.consentId,textVersion:1,expiresAt:ownedOffer.terms.expiresAt}};}
  async commitAcceptance(input) {
    commitRequested=true;
    const deadline=Date.now()+8000;
    while(settings.blockCommit&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    if(settings.blockCommit||settings.failCommit) throw Error('test_commit_unavailable');
    event=input.event;committed=true;status='pending';return {status:'created',acceptance:input.acceptance};
  }
  async query(sql, args) {
    if (sql.includes("SET status='publishing'")) {
      const deadline=Date.now()+8000;
      while(settings.blockQueueClaim&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
      if(settings.blockQueueClaim) throw Error('test_release_queue_timeout');
    }
    if (sql.includes("SET status='publishing'") && status === 'pending') {
      status = 'publishing';
      return {rows:[{event_id:event.eventId,payload:event,attempts:'1',correlation_id:event.correlationId,aggregate_id:event.payload.offerId}],rowCount:1};
    }
    if (sql.includes("SET status='published'")) {status='published';return {rows:[],rowCount:1};}
    if (sql.includes('SET status=$3')) {status=args[2];return {rows:[],rowCount:1};}
    return {rows:sql.includes('age_ms')?[{age_ms:null}]:[],rowCount:0};
  }
  async queued(value) { queued.push(value); }
  async imported(value) {
    rpcAttempts++;
    if(settings.httpCase&&!committed) throw Error('import_before_acceptance_commit');
    imported.push(value);
    const deadline = Date.now()+8000;
    while (settings.blockRpc && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    if (settings.blockRpc) throw Error('test_release_timeout');
    return {status:'ok',policy:{policyId:'50000000-0000-4000-8000-000000000001',offerId:value.payload.offerId,offerVersion:value.payload.offerVersion}};
  }
}`;
const receiver = `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint {
  async authorizeFinancialAccessV1(input) {return this.env.STATE.authorize(input);}
  async acceptOfferV1(value) {return this.env.STATE.imported(value);}
  async queue(batch) {for (const message of batch.messages) {await this.env.STATE.queued(message.body);message.ack();}}
}`;

test('a post-commit HTTP acceptance imports independently while its signed outbox retains Queue recovery', { timeout: 30_000 }, async t => {
  const config = JSON.parse(await readFile('backend/acquisition-risk/wrangler.jsonc', 'utf8'));
  const producer = await build({ entryPoints:['backend/acquisition-risk/src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*','node:*'],
    plugins:[{name:'explicit-sql-transport',setup(builder){
      builder.onResolve({filter:/sql-offer-store$/},()=>({path:'offer-store',namespace:'offer-collaborator'}));
      builder.onLoad({filter:/.*/,namespace:'offer-collaborator'},()=>({loader:'js',contents:
        "import {env} from 'cloudflare:workers';export class SqlOfferStore{async acceptanceSnapshot(){return {offer:await env.STATE.offer(),acceptance:null}}async accept(input){return env.STATE.commitAcceptance(input)}}"}));
      builder.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'collaborator'}));
      builder.onLoad({filter:/.*/,namespace:'collaborator'},()=>({loader:'js',contents:
        "import {env} from 'cloudflare:workers';export class Client{on(){}async connect(){}async query(sql,args){return env.STATE.query(sql,args)}async end(){}}"}));
    }}] });
  const stateBundle = await build({stdin:{contents:stateSource,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*']});
  const worker = (name, rpc) => ({name,modules:true,script:producer.outputFiles[0].text,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
    bindings:{APP_ENV:'local',SIGNAL_PROVIDER:'direct_simulated',QUOTE_HMAC_KEY:'c'.repeat(64),FINANCIAL_PROVIDER_MODE:'mock',FINANCIAL_EVENT_KEY:'b'.repeat(64),ACQUISITION_DB:{connectionString:'postgresql://synthetic.invalid/unused'}},
    serviceBindings:{STATE:'state',IDENTITY_SERVICE:'receiver',...(rpc?{POLICY_SERVICE:'receiver'}:{})},queueProducers:{FINANCIAL_EVENTS:'events'}});
  const runtime = new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,workers:[worker('producer',true),worker('legacy',false),
    {name:'state',modules:true,script:stateBundle.outputFiles[0].text,compatibilityDate:config.compatibility_date},
    {name:'receiver',modules:true,script:receiver,compatibilityDate:config.compatibility_date,serviceBindings:{STATE:'state'},
      queueConsumers:{events:{maxBatchSize:1,maxBatchTimeout:0,maxRetries:2}}}]}));
  t.after(()=>runtime.dispose()); await runtime.ready;
  const state = await runtime.getWorker('state');
  const configure = async settings => {await state.fetch('http://state/configure',{method:'POST',body:JSON.stringify(settings)});};
  const snapshot = async () => (await state.fetch('http://state/')).json();
  const until = async predicate => {
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){const value=await snapshot();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.fail('Producer did not reach the expected observable state');
  };
  const accept = async worker => {
    const value=await snapshot();
    return (await runtime.getWorker(worker)).fetch('http://producer/api/v1/offers/'+value.ownedOffer.terms.offerId+'/accept',{
      method:'POST',headers:{'content-type':'application/json','idempotency-key':'native-post-commit','x-trace-id':crypto.randomUUID()},body:'{}'});
  };
  await t.test('RPC cannot start before commit and HTTP does not wait for outbox claim, Queue or import completion', async () => {
    await configure({httpCase:true,blockCommit:true,blockQueueClaim:true,blockRpc:true});
    const response=accept('producer');
    const before=await until(value=>value.commitRequested);
    assert.equal(before.committed,false);assert.equal(before.rpcAttempts,0);assert.deepEqual(before.queued,[]);
    await state.fetch('http://state/release-commit');
    const accepted=await response;assert.equal(accepted.status,202);
    const body=await accepted.json();assert.equal(Object.hasOwn(body,'committedEvent'),false);assert.equal(Object.hasOwn(body,'signature'),false);
    const imported=await until(value=>value.imported.length===1);
    assert.equal(imported.status,'pending');assert.deepEqual(imported.queued,[]);
    assert.deepEqual(imported.imported[0],imported.event);
    assert.equal(imported.event.eventId,body.eventId);
    await state.fetch('http://state/release-queue');
    const published=await until(value=>value.status==='published'&&value.queued.length===1);
    assert.deepEqual(published.queued[0],published.event);
    await state.fetch('http://state/release');
  });
  await t.test('a failed owner commit starts neither import nor Queue publication', async () => {
    await configure({httpCase:true,failCommit:true});
    const response=await accept('producer');assert.equal(response.status,503);
    const failed=await snapshot();assert.equal(failed.committed,false);assert.equal(failed.rpcAttempts,0);assert.deepEqual(failed.queued,[]);
  });
  await t.test('an absent RPC binding keeps the existing Queue-only deployment compatible', async () => {
    await configure({httpCase:true});
    const response=await accept('legacy');assert.equal(response.status,202);
    const published=await until(value=>value.status==='published'&&value.queued.length===1);
    assert.deepEqual(published.imported,[]);
  });
  await t.test('a tampered outbox event reaches neither Queue nor RPC', async () => {
    await configure({tamper:true});
    assert.equal((await (await runtime.getWorker('producer')).scheduled({cron:'* * * * *'})).outcome,'ok');
    const rejected=await snapshot();
    assert.equal(rejected.status,'dead_letter');
    assert.deepEqual(rejected.queued,[]);assert.deepEqual(rejected.imported,[]);
  });
});
