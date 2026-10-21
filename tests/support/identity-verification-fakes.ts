import { createHash, randomUUID } from 'node:crypto';
import type { VerificationContext, VerificationOperation, VerificationPlan, VerificationStore } from '../../backend/identity-consent-ecosystem/src/application/ports/identity-verification';
import type { VerificationCommand } from '../../backend/identity-consent-ecosystem/src/application/ports/identity-verification';
import { VerificationFailure } from '../../backend/identity-consent-ecosystem/src/domain/identity-verification';
import type { VerificationState } from '../../backend/identity-consent-ecosystem/src/domain/identity-verification';
import { IdentityVerifications } from '../../backend/identity-consent-ecosystem/src/application/identity-verifications';
import { SyntheticVerificationCorpus, syntheticKycSource } from '../../backend/identity-consent-ecosystem/src/adapters/outbound/synthetic-identity-verification';
import { KycProvider } from '../../backend/identity-consent-ecosystem/src/adapters/outbound/kyc-provider';
import type { KycSource } from '../../backend/identity-consent-ecosystem/src/adapters/outbound/kyc-provider';

export const verificationIdentity = { providerSubject: 'synthetic-kyc-owner', sessionReference: 'synthetic-kyc-session', emailVerified: true };
export const verificationOther = { providerSubject: 'synthetic-kyc-other', sessionReference: 'synthetic-kyc-other-session', emailVerified: true };

// A transactional test double, not evidence of SQL isolation, HMAC validation or a durable write.
export class MemoryVerificationStore implements VerificationStore {
  now = '2026-10-21T15:00:00.000Z';
  rows = new Map<string, { state: VerificationState; current: boolean }>();
  commands = new Map<string, VerificationCommand>();
  events: NonNullable<VerificationPlan<unknown>['event']>[] = [];
  denied = false;
  failNextCommit = false;
  transactionOpen = false;
  private queue: Promise<unknown> = Promise.resolve();
  readonly users = new Map([
    [verificationIdentity.providerSubject, { clientId: randomUUID(), subjectToken: randomUUID(), session: verificationIdentity.sessionReference }],
    [verificationOther.providerSubject, { clientId: randomUUID(), subjectToken: randomUUID(), session: verificationOther.sessionReference }],
  ]);
  execute<T>(input: VerificationOperation, decide: (context: VerificationContext) => Promise<VerificationPlan<T>>): Promise<T> {
    const operation = this.queue.then(async () => {
      const owner = this.users.get(input.identity.providerSubject);
      if (this.denied || !input.identity.emailVerified || !owner || input.identity.sessionReference !== owner.session) throw new VerificationFailure('unauthorized', 401);
      const key = owner.clientId + ':' + input.command?.key;
      const command = input.command ? this.commands.get(key) ?? null : null;
      const caseId = input.caseId ?? command?.caseId;
      const row = caseId ? this.rows.get(caseId) : [...this.rows.values()].find(row => row.current && row.state.clientId === owner.clientId);
      const owned = row?.state.clientId === owner.clientId ? row : undefined;
      this.transactionOpen = true;
      let plan: VerificationPlan<T>;
      try { plan = await decide({ principal: { clientId: owner.clientId, subjectToken: owner.subjectToken }, now: this.now,
        record: owned ? structuredClone(owned.state) : null, current: owned?.current ?? false, command: structuredClone(command) }); }
      finally { this.transactionOpen = false; }
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('synthetic_commit_failed'); }
      if (plan.record) {
        if (owned && owned.state.id !== plan.record.id) this.rows.set(owned.state.id, { state: { ...owned.state, evidence: {}, result: null, pending: null }, current: false });
        this.rows.set(plan.record.id, { state: structuredClone(plan.record), current: owned?.state.id === plan.record.id ? owned.current : true });
      }
      if (plan.command) this.commands.set(key, structuredClone(plan.command));
      if (plan.event) this.events.push(structuredClone(plan.event));
      return plan.value;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export function verificationSetup(source?: KycSource) {
  const store = new MemoryVerificationStore();
  const corpus = new SyntheticVerificationCorpus();
  let calls = 0;
  const deps = { store, corpus, platform: { now: () => new Date(store.now), newId: randomUUID },
    integrity: { seal: async (value: string) => createHash('sha256').update('synthetic-test-key:' + value).digest('hex'),
      digest: async (value: string) => createHash('sha256').update(value).digest('hex') },
    provider: new KycProvider(async (input, signal) => { calls++; if (store.transactionOpen) throw new Error('provider_inside_transaction'); return (source ?? syntheticKycSource)(input, signal); }, 1000),
  };
  const application = new IdentityVerifications(deps);
  const context = (caseId = '', key = randomUUID()) => ({ identity: verificationIdentity, traceId: randomUUID(), caseId, key });
  const fixture = (reference: string) => {
    const item = corpus.list().find(item => item.reference === reference);
    if (!item) throw new Error('test_fixture_missing');
    return { reference: item.reference, sha256: item.sha256, corpusVersion: item.corpusVersion };
  };
  return { application, deps, store, context, fixture, get calls() { return calls; } };
}
