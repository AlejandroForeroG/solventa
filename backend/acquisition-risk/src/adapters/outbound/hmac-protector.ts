import type { Protector } from '../../application/ports/platform';
import type { QuoteRequest } from '../../domain/quote';

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

// 64 hex characters, as quotes.request_hash requires. The key keeps tokens from being brute-forced from a list of documents.
export class HmacProtector implements Protector {
  private key?: Promise<CryptoKey>;
  constructor(private readonly secret: string) {}
  private sign(message: string) {
    // Checked on use so requests rejected earlier never depend on the secret.
    if (this.secret.length < 32) return Promise.reject(Object.assign(new Error('quote_hmac_key_invalid'), { code: 'quote_hmac_key_invalid' }));
    this.key ??= crypto.subtle.importKey('raw', new TextEncoder().encode(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return this.key.then(key => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))).then(hex);
  }
  fingerprint(partnerId: string, request: QuoteRequest) {
    const { customer: c, credit: k } = request;
    return this.sign(JSON.stringify(['request', partnerId, request.product, c.fullName, c.documentType, c.documentNumber, c.birthDate, c.city, k.partnerCreditId, k.amount, k.termMonths]));
  }
  documentToken(documentNumber: string) { return this.sign(JSON.stringify(['document', documentNumber])); }
}
