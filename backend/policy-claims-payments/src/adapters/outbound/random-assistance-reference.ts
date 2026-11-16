// Crockford base32 without I, L, O and U: a reference read aloud over the phone is not misheard. A collision is drawn again by the store.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newAssistanceReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'ASI-' + [...bytes].map(byte => ALPHABET[byte % 32]).join('');
}
