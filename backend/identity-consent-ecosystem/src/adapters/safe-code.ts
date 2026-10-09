// Only a short identifier is logged: exception messages can contain anything, including personal data.
export function safeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'unexpected_error';
}
