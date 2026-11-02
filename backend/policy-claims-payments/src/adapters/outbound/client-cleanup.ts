export type ClientLifecycle = { waitUntil(work: Promise<unknown>): void };

// Only transport teardown can leave the response path. Callers await all queries and
// COMMIT/ROLLBACK before reaching this point; the actual close remains retained.
export async function closeClient(client: { end(): Promise<void> }, lifecycle?: ClientLifecycle): Promise<void> {
  const closed = client.end().catch(() => {});
  if (lifecycle) {
    try { lifecycle.waitUntil(closed); return; }
    catch { /* Without a usable invocation context, await the real cleanup. */ }
  }
  await closed;
}
