import type { Context } from 'hono';
import type { EstimateQuote } from '../../application/estimate-quote';

const MAX_BODY = 1024;
export function estimateHandler(estimates: EstimateQuote) {
  return async (c: Context) => {
    const supplied = c.req.header('x-trace-id') ?? '';
    const traceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    const headers = { 'cache-control': 'no-store', 'x-trace-id': traceId };
    const invalid = () => c.json({ error: 'validation_error', errors: [{ field: '', code: 'invalid_format' }], traceId }, 400, headers);
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return invalid();
    if (Number(c.req.header('content-length')) > MAX_BODY) return invalid();
    const reader = c.req.raw.body?.getReader();
    if (!reader) return invalid();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let input: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { await reader.cancel().catch(() => {}); return invalid(); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return invalid(); }
    const result = estimates.execute(input);
    return result.status === 'invalid'
      ? c.json({ error: 'validation_error', errors: result.errors, traceId }, 400, headers)
      : c.json({ ...result.estimate, traceId }, 200, headers);
  };
}
