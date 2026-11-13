import type { AdvisorAuthorizationRecord } from '../../backend/policy-claims-payments/src/domain/advisor-authorization';
import { randomUUID } from 'node:crypto';
import { PolicyFinance } from '../../backend/policy-claims-payments/src/application/policy-finance';
import { issuanceTimeContent, offerContent, paymentContent, policyDocument } from '../../backend/policy-claims-payments/src/domain/financial';
import type { FinancialStore, FinancialTransaction, PolicyRecord, Payment, StoredPolicy } from '../../backend/policy-claims-payments/src/application/ports/financial';
import { acceptedOffer, financialIntegrity, financialNow } from '../financial-fixtures';
export async function lifecycleRecord(owner?: { clientId: string; subjectToken: string }, from = financialNow().toISOString(), ids?: { policyId: string; acceptanceId: string; offerId: string }): Promise<PolicyRecord> {
  const offer = (await acceptedOffer()).payload;
  if (owner) Object.assign(offer, owner);
  if (ids) { offer.acceptanceId = ids.acceptanceId; offer.offerId = ids.offerId; }
  offer.effectiveFrom = from; offer.acceptedAt = from;
  offer.expiresAt = new Date(Date.parse(from) + 900000).toISOString();
  offer.effectiveUntil = new Date(Date.parse(from) + 365 * 86400000).toISOString();
  const id = ids?.policyId ?? randomUUID(), document = policyDocument(id, offer);
  const policy: StoredPolicy = { id, clientId: offer.clientId, subjectToken: offer.subjectToken, status: 'issued', offer,
    termsHash: await financialIntegrity.digest(offerContent(offer)), document, documentHash: await financialIntegrity.digest(document),
    premium: offer.premium, currency: 'COP', offerId: offer.offerId, offerVersion: offer.offerVersion, effectiveFrom: from,
    effectiveUntil: offer.effectiveUntil, coverageSnapshot: offer.coverage };
  const premium: Payment = { id: randomUUID(), policyId: id, operation: 'premium', key: 'initial-premium', amount: offer.premium,
    currency: 'COP', hash: '', status: 'confirmed', providerReference: null, updatedAt: from };
  premium.hash = await financialIntegrity.digest(paymentContent(premium)); premium.providerReference = 'MOCK-' + premium.id;
  return { policy, premium, signature: { documentHash: policy.documentHash, signedAt: from,
    receipt: await financialIntegrity.digest(JSON.stringify(['mock-signature-v1', id, policy.documentHash])),
    timeSeal: await financialIntegrity.digest(issuanceTimeContent(id, policy.documentHash, from)) } };
}
const unexpected = async (): Promise<never> => { throw Error('unexpected_dependency'); };
export function lifecycleFixture(initial: PolicyRecord[], newId:()=>string=randomUUID) {
  let records = new Map(initial.map(record => [record.policy.id, record]));
  const commands = new Map<string, { policyId: string; requestHash: string }>();
  const captures: unknown[] = [];
  let approvals = new Map<string, {record:AdvisorAuthorizationRecord;key:string;requestHash:string}>();
  let hook: {stage:'command'|'write';run():void}|null=null;
  let serial: Promise<unknown> = Promise.resolve();
  let failWrite = false;
  let now = new Date('2026-10-16T02:01:00.000Z');
  const store: FinancialStore = { readOwnPolicies: async (actor, limit, includeEnded = true) => [...records.values()]
    .filter(record => record.policy.clientId === actor.clientId && record.policy.subjectToken === actor.subjectToken && record.policy.status === 'issued'
      && (includeEnded || !record.policy.lifecycle)).slice(0, limit), readAcceptedPolicy: unexpected, importAcceptance: unexpected,
    issuanceCandidates: unexpected, rejection: async () => {}, readPolicy: async (id, actor) => {
      const record = records.get(id); return record?.policy.clientId === actor.clientId && record.policy.subjectToken === actor.subjectToken ? record : null;
    }, transaction: work => {
      const run = serial.then(async () => {
        const pending = structuredClone(records), pendingApprovals=structuredClone(approvals), pendingCommands=structuredClone(commands), pendingCaptures:unknown[]=[];
        const tx = { policy: async (id: string, actor?: { clientId: string; subjectToken: string }) => {
          const record = pending.get(id); return record && (!actor || record.policy.clientId === actor.clientId && record.policy.subjectToken === actor.subjectToken) ? record : null;
        }, lifecycleCommand: async (actor: string, key: string) => {if(hook?.stage==='command')hook.run();return pendingCommands.get(actor + key) ?? null;},
        advisorAuthorization: async (id,actor,role) => {const a=pendingApprovals.get(id)?.record;return a&&a.authorization[role].clientId===actor.clientId&&a.authorization[role].subjectToken===actor.subjectToken?a:null;},
        advisorAuthorizationCommand: async (actor,key) => {const a=[...pendingApprovals.values()].find(a=>a.record.authorization.owner.clientId===actor.clientId&&a.record.authorization.owner.subjectToken===actor.subjectToken&&a.key===key);return a?{record:a.record,requestHash:a.requestHash}:null;},
        listAdvisorAuthorizations: async (actor,role,policyId,limit,reference,after)=>[...pendingApprovals.values()].map(a=>a.record).filter(a=>a.authorization[role].clientId===actor.clientId&&a.authorization[role].subjectToken===actor.subjectToken&&(!policyId||a.authorization.policyId===policyId)&&(!reference||a.authorization.advisorReference===reference)&&(!after||a.authorization.grantedAt<after.grantedAt||(a.authorization.grantedAt===after.grantedAt&&a.authorization.id<after.id))).sort((a,b)=>b.authorization.grantedAt.localeCompare(a.authorization.grantedAt)||b.authorization.id.localeCompare(a.authorization.id)).slice(0,limit),
        saveAdvisorAuthorization: async (authorization,key,requestHash,capture)=>{if(failWrite)throw Error('audit_failed');pendingApprovals.set(authorization.id,{record:{authorization,revokedAt:null,changeId:null},key,requestHash});pendingCaptures.push(capture);},
        revokeAdvisorAuthorization: async (authorization,at,capture)=>{if(failWrite)throw Error('audit_failed');const a=pendingApprovals.get(authorization.id);if(!a)throw Error('missing');a.record.revokedAt=at;pendingCaptures.push(capture);},
        lifecycleReplacement: async (id: string) => [...pending.values()].some(record => record.policy.lifecycle?.replacementPolicyId === id),
        saveLifecycle: async (change, actor: string, key: string, requestHash: string, capture, _traceId, execution) => {
          if(hook?.stage==='write')hook.run();
          if (failWrite) throw Error('audit_failed');
          const record = pending.get(change.policyId); if (!record) throw Error('missing_record');
          record.policy.lifecycle = change;
          pendingCommands.set(actor + key, { policyId: change.policyId, requestHash }); pendingCaptures.push(capture);
          if(execution){const a=pendingApprovals.get(execution.authorizationId);if(!a)throw Error('missing');a.record.changeId=change.changeId;}
        } } satisfies Pick<FinancialTransaction, 'policy' | 'lifecycleCommand' | 'lifecycleReplacement' | 'saveLifecycle' | 'advisorAuthorization' | 'advisorAuthorizationCommand' | 'listAdvisorAuthorizations' | 'saveAdvisorAuthorization' | 'revokeAdvisorAuthorization'>;
        const result = await work(tx as FinancialTransaction); records = pending; approvals=pendingApprovals;commands.clear();for(const [k,v] of pendingCommands)commands.set(k,v);captures.push(...pendingCaptures);return result;
      }); serial = run.catch(() => {}); return run;
    } };
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: () => now,
    newId, store, payments: { lookup: unexpected, settle: unexpected, refund: unexpected }, signatures: { sign: unexpected } });
  return { finance, captures, during:(stage:'command'|'write',run:()=>void)=>{hook={stage,run};}, approval:(id:string)=>approvals.get(id)?.record, record: (id: string) => records.get(id), fail: () => { failWrite = true; }, setNow: (date: string) => { now = new Date(date); } };
}
