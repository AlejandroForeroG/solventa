function bodyLimit(path: string): number {
  if (/^\/api\/v[12]\/policies(?:\/|$)/.test(path) || /^\/api\/v1\/(?:offers(?:\/|$)|quotes\/[^/]+\/offers(?:\/|$))/.test(path)) return 1024;
  if (/^\/api\/v1\/(?:(?:me\/)?quotes|quote-estimates)(?:\/|$)/.test(path)) return 16 * 1024;
  if (/^\/api\/v1\/consents(?:\/|$)/.test(path)) return 4 * 1024;
  if (/^\/api\/v1\/mobile\/identity-verifications(?:\/|$)/.test(path)) return 4 * 1024;
  // Access and native-session endpoints use headers only, never a JSON body.
  return 0;
}

export async function fetchService(request: Request, binding: Pick<Fetcher, 'fetch'>): Promise<Response> {
  const controller = new AbortController();
  const reader = request.body?.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(Error('service_deadline'));
    }, 5000);
  });
  const send = async () => {
    let body: Uint8Array | null = null;
    const headers = new Headers(request.headers);
    if (reader) {
      const limit = bodyLimit(new URL(request.url).pathname);
      const chunks: Uint8Array[] = [];
      let length = 0, oversized = Number(headers.get('content-length')) > limit;
      if (!oversized) for (;;) {
        pendingRead = reader.read();
        const next = await pendingRead;
        if (controller.signal.aborted) throw Error('service_deadline');
        if (next.done) break;
        length += next.value.byteLength;
        if (length > limit) { oversized = true; break; }
        chunks.push(next.value);
      }
      if (oversized) {
        await reader.cancel();
        // Keep owner authentication/authorization ahead of JSON validation. The
        // rejected upload's data never crosses the binding or enters a parser.
        body = new Uint8Array([123]);
        headers.delete('content-length');
      } else {
        body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      }
      if (request.method === 'GET' || request.method === 'HEAD') { body = null; headers.delete('content-length'); }
    }
    if (controller.signal.aborted) throw Error('service_deadline');
    return binding.fetch(new Request(request, { headers, body, signal: controller.signal }));
  };
  try { return await Promise.race([send(), deadline]); }
  finally {
    // A finite upload no longer references the incoming stream when the binding
    // responds early. Do not abort successful response streams during cleanup.
    clearTimeout(timeout);
    if (reader) {
      await reader.cancel().catch(() => {});
      await pendingRead?.catch(() => {});
      reader.releaseLock();
    }
  }
}
