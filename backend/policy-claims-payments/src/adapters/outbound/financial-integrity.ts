import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FinancialIntegrity } from '../../application/ports/financial';

export class HmacFinancialIntegrity implements FinancialIntegrity {
  constructor(private readonly key: string) {}
  async digest(content: string): Promise<string> {
    if (this.key.length < 32) throw new Error('financial_key_unavailable');
    return createHmac('sha256', this.key).update(content).digest('hex');
  }
  async verify(content: string, signature: string): Promise<boolean> {
    const expected = await this.digest(content);
    return /^[0-9a-f]{64}$/.test(signature) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  }
}
