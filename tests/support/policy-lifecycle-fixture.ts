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
export function lifecycleFixture(initial: PolicyRecord[]) {
  let records = new Map(initial.map(record => [record.policy.id, record]));
  const commands = new Map<string, { policyId: string; requestHash: string }>();
  const captures: unknown[] = [];
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
        const pending = structuredClone(records);
        const tx = { policy: async (id: string, actor?: { clientId: string; subjectToken: string }) => {
          const record = pending.get(id); return record && (!actor || record.policy.clientId === actor.clientId && record.policy.subjectToken === actor.subjectToken) ? record : null;
        }, lifecycleCommand: async (actor: string, key: string) => commands.get(actor + key) ?? null,
        lifecycleReplacement: async (id: string) => [...pending.values()].some(record => record.policy.lifecycle?.replacementPolicyId === id),
        saveLifecycle: async (change, actor: string, key: string, requestHash: string, capture) => {
          if (failWrite) throw Error('audit_failed');
          const record = pending.get(change.policyId); if (!record) throw Error('missing_record');
          record.policy.lifecycle = change;
          commands.set(actor + key, { policyId: change.policyId, requestHash }); captures.push(capture);
        } } satisfies Pick<FinancialTransaction, 'policy' | 'lifecycleCommand' | 'lifecycleReplacement' | 'saveLifecycle'>;
        const result = await work(tx as FinancialTransaction); records = pending; return result;
      }); serial = run.catch(() => {}); return run;
    } };
  const finance = new PolicyFinance({ enabled: true, environment: 'local', integrity: financialIntegrity, now: () => now,
    newId: randomUUID, store, payments: { lookup: unexpected, settle: unexpected, refund: unexpected }, signatures: { sign: unexpected } });
  return { finance, captures, record: (id: string) => records.get(id), fail: () => { failWrite = true; }, setNow: (date: string) => { now = new Date(date); } };
}
