import { Client } from 'pg';
import { closeClient, type ClientLifecycle } from './client-cleanup';
import type { FinancialIntegrity, Payment, PaymentGateway, SignatureProvider } from '../../application/ports/financial';

type GatewayRow = { request_hash: string; operation: string; amount: string; currency: string; status: 'confirmed' | 'refunded'; provider_reference: string };

export class SqlMockPaymentGateway implements PaymentGateway {
  constructor(private readonly connectionString: string, private readonly lifecycle?: ClientLifecycle) {}
  private async client<T>(work: (db: Client) => Promise<T>): Promise<T> {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    db.on('error', () => {});
    try { await db.connect(); return await work(db); }
    finally { await closeClient(db, this.lifecycle); }
  }
  private checked(row: GatewayRow | undefined, input: Payment): GatewayRow | null {
    if (row && (row.request_hash !== input.hash || row.operation !== input.operation || row.amount !== input.amount || row.currency !== input.currency)) throw new Error('mock_gateway_conflict');
    return row ?? null;
  }
  private async find(db: Client, input: Payment): Promise<GatewayRow | null> {
    const row = (await db.query<GatewayRow>('SELECT request_hash,operation,amount::STRING,currency,status,provider_reference FROM policy.mock_gateway_operations WHERE payment_id=$1', [input.id])).rows[0];
    return this.checked(row, input);
  }
  async settle(input: Payment): Promise<{ status: 'confirmed' | 'declined'; reference: string | null }> {
    return this.client(async db => {
      const inserted = await db.query<GatewayRow>(`INSERT INTO policy.mock_gateway_operations(payment_id,request_hash,operation,amount,currency,status,provider_reference)
        VALUES($1,$2,$3,$4,$5,'confirmed',$6) ON CONFLICT(payment_id) DO NOTHING
        RETURNING request_hash,operation,amount::STRING,currency,status,provider_reference`,
      [input.id, input.hash, input.operation, input.amount, input.currency, 'MOCK-' + input.id]);
      // A conflict still reads and verifies the original operation; never overwrite a refund or mismatched request.
      const row = inserted.rows.length ? this.checked(inserted.rows[0], input) : await this.find(db, input);
      if (!row) throw new Error('mock_gateway_unavailable');
      return { status: row.status === 'confirmed' ? 'confirmed' : 'declined', reference: row.provider_reference };
    });
  }
  async lookup(input: Payment): Promise<{ status: 'confirmed' | 'refunded' | 'unknown'; reference: string | null }> {
    return this.client(async db => {
      const row = await this.find(db, input);
      return row ? { status: row.status, reference: row.provider_reference }
        : { status: 'unknown', reference: null };
    });
  }
  async refund(input: Payment): Promise<{ status: 'refunded'; reference: string | null }> {
    return this.client(async db => {
      const row = await this.find(db, input);
      if (!row || input.operation !== 'premium') throw new Error('mock_refund_unavailable');
      await db.query("UPDATE policy.mock_gateway_operations SET status='refunded' WHERE payment_id=$1 AND status='confirmed'", [input.id]);
      return { status: 'refunded', reference: row.provider_reference };
    });
  }
}

export class MockSignatureProvider implements SignatureProvider {
  constructor(private readonly integrity: FinancialIntegrity) {}
  async sign(policyId: string, documentHash: string): Promise<{ status: 'signed'; receipt: string }> {
    return { status: 'signed', receipt: await this.integrity.digest(JSON.stringify(['mock-signature-v1', policyId, documentHash])) };
  }
}
