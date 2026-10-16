const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalTraceId(value: unknown): string | null {
  return typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null;
}
