import type { Integrity } from '../../application/ports/consents';

const MIN_KEY_LENGTH = 32;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export class HmacIntegrity implements Integrity {
  constructor(private readonly key: string) {}

  // The key is checked on use so requests that never seal or verify do not depend on the secret.
  async seal(content: string): Promise<string> {
    if (this.key.length < MIN_KEY_LENGTH) throw new Error('consent_seal_key_missing');
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(content)));
  }

  async digest(content: string): Promise<string> {
    return hex(await crypto.subtle.digest('SHA-256', encoder.encode(content)));
  }
}
