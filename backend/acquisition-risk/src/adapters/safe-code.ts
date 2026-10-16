// Exception metadata is untrusted: even a short alphanumeric code can contain personal data.
const technicalCodes: ReadonlySet<string> = new Set([
  '08001', '08003', '08006', '08P01',
  '22001', '22003', '22P02', '23502', '23503', '23505', '23514',
  '25P02', '28P01', '3D000', '3F000', '40001', '40P01',
  '42501', '42601', '42703', '42P01', '53300', '57014',
  '57P01', '57P02', '57P03', 'XX000',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'quote_hmac_key_invalid',
]);

export function safeCode(error: unknown, fallback: 'unexpected_error' | 'connection_failed' = 'unexpected_error'): string {
  try {
    if (error === null || typeof error !== 'object') return fallback;
    // Inspect only an own data property; never invoke a getter while handling another failure.
    const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    return typeof code === 'string' && technicalCodes.has(code) ? code : fallback;
  } catch {
    return fallback;
  }
}
