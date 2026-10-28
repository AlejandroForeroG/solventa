import { PolicyFinance } from '../application/policy-finance';
import { HmacFinancialIntegrity } from './outbound/financial-integrity';
import { SqlFinancialStore } from './outbound/sql-financial-store';
import { MockSignatureProvider, SqlMockPaymentGateway } from './outbound/mock-financial-providers';
import type { ClientLifecycle } from './outbound/client-cleanup';

type FinancialConfiguration = { APP_ENV: string; FINANCIAL_PROVIDER_MODE?: string; FINANCIAL_EVENT_KEY?: string;
  POLICY_DB: { connectionString: string } };

export function createPolicyFinance(env: FinancialConfiguration, lifecycle?: ClientLifecycle): PolicyFinance {
  const enabled = ['local', 'dev', 'staging'].includes(env.APP_ENV) && env.FINANCIAL_PROVIDER_MODE === 'mock'
    && typeof env.FINANCIAL_EVENT_KEY === 'string' && /^[a-f0-9]{64}$/.test(env.FINANCIAL_EVENT_KEY);
  const environment = env.APP_ENV === 'local' ? 'local' : env.APP_ENV === 'staging' ? 'staging' : 'dev';
  const integrity = new HmacFinancialIntegrity(env.FINANCIAL_EVENT_KEY ?? '');
  return new PolicyFinance({ enabled, environment, integrity,
    store: new SqlFinancialStore(env.POLICY_DB.connectionString, lifecycle), payments: new SqlMockPaymentGateway(env.POLICY_DB.connectionString, lifecycle),
    signatures: new MockSignatureProvider(integrity), now: () => new Date(), newId: () => crypto.randomUUID() });
}
