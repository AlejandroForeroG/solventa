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
let settings = {}, event, status = 'pending', queued = [], imported = [];
export default class extends WorkerEntrypoint {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/configure') {
      settings = await request.json(); status = 'pending'; queued = []; imported = [];
      const at = new Date().toISOString();
      event = await new HmacOfferIntegrity('b'.repeat(64)).sign({version:1,eventType:'offer.accepted',eventId:crypto.randomUUID(),environment:'local',synthetic:true,
        occurredAt:at,correlationId:crypto.randomUUID(),payload:{acceptanceId:crypto.randomUUID(),offerId:crypto.randomUUID(),offerVersion:1,
          clientId:crypto.randomUUID(),subjectToken:crypto.randomUUID(),product:'vida_hipotecario',premium:'10000.0000',currency:'COP',
          coverage:{kind:'mortgage_life',sumInsured:'100000000.0000'},effectiveFrom:at,effectiveUntil:'2027-10-27T00:00:00.000Z',
          expiresAt:new Date(Date.now()+900000).toISOString(),ruleVersion:'academic-mortgage-1',acceptedAt:at}});
      if (settings.tamper) event.payload.premium = '1.0000';
    }
    if (path === '/release') settings.blockRpc = false;
    return Response.json({ event, status, queued, imported });
  }
  async query(sql, args) {
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
    imported.push(value);
    const deadline = Date.now()+8000;
    while (settings.blockRpc && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    if (settings.blockRpc) throw Error('test_release_timeout');
    return {status:'ok',policy:{policyId:'50000000-0000-4000-8000-000000000001',offerId:value.payload.offerId,offerVersion:value.payload.offerVersion}};
  }
}`;
const receiver = `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint {
  async acceptOfferV1(value) {return this.env.STATE.imported(value);}
  async queue(batch) {for (const message of batch.messages) {await this.env.STATE.queued(message.body);message.ack();}}
}`;

test('a committed signed outbox event retains Queue recovery while the additional RPC imports it independently', { timeout: 30_000 }, async t => {
  const config = JSON.parse(await readFile('backend/acquisition-risk/wrangler.jsonc', 'utf8'));
  const producer = await build({ entryPoints:['backend/acquisition-risk/src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*','node:*'],
    plugins:[{name:'explicit-sql-transport',setup(builder){
      builder.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'collaborator'}));
      builder.onLoad({filter:/.*/,namespace:'collaborator'},()=>({loader:'js',contents:
        "import {env} from 'cloudflare:workers';export class Client{on(){}async connect(){}async query(sql,args){return env.STATE.query(sql,args)}async end(){}}"}));
    }}] });
  const stateBundle = await build({stdin:{contents:stateSource,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*']});
  const worker = (name, rpc) => ({name,modules:true,script:producer.outputFiles[0].text,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
    bindings:{APP_ENV:'local',FINANCIAL_PROVIDER_MODE:'mock',FINANCIAL_EVENT_KEY:'b'.repeat(64),ACQUISITION_DB:{connectionString:'postgresql://synthetic.invalid/unused'}},
    serviceBindings:{STATE:'state',...(rpc?{POLICY_SERVICE:'receiver'}:{})},queueProducers:{FINANCIAL_EVENTS:'events'}});
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
  await t.test('a pending import cannot delay durable publication and both transports preserve the same signed identity', async () => {
    await configure({blockRpc:true});
    const invocation=(await runtime.getWorker('producer')).scheduled({cron:'* * * * *'});
    const published=await until(value=>value.status==='published'&&value.imported.length===1&&value.queued.length===1);
    assert.deepEqual(published.imported[0],published.event);
    assert.deepEqual(published.queued[0],published.event);
    await state.fetch('http://state/release');
    assert.equal((await invocation).outcome,'ok');
  });
  await t.test('an absent RPC binding keeps the existing Queue-only deployment compatible', async () => {
    await configure({});
    assert.equal((await (await runtime.getWorker('legacy')).scheduled({cron:'* * * * *'})).outcome,'ok');
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
