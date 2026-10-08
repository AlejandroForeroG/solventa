const root = '/api/docs';
const staticFiles = new Map([
  ['/', 'text/html'],
  ['/index.html', 'text/html'],
  ['/catalog.json', 'application/json'],
  ['/scalar.js', 'javascript'],
  ['/wordmark.svg', 'image/svg+xml'],
  ['/viewer.js', 'javascript'],
  ['/viewer.css', 'text/css'],
]);

export function isApiDocsPath(path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export async function serveApiDocs(request: Request, env: Pick<WebEnv, 'ASSETS' | 'APP_ENV'>): Promise<Response> {
  const url = new URL(request.url);
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-solventa-environment': env.APP_ENV };
  if (request.method !== 'GET' && request.method !== 'HEAD') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  if (url.pathname === root) {
    url.pathname += '/';
    return new Response(null, { status: 308, headers: { ...headers, location: url.href } });
  }
  const relative = url.pathname.slice(root.length);
  const type = staticFiles.get(relative) ?? (/^\/v[1-9][0-9]*\/[a-z][a-z0-9-]*\.json$/.test(relative) ? 'application/json' : undefined);
  if (!type) return Response.json({ error: 'not_found' }, { status: 404, headers });
  const asset = await env.ASSETS.fetch(request);
  // SPA fallback is an HTML success: it must not masquerade as a missing spec or script.
  if (asset.status === 200 && !asset.headers.get('content-type')?.includes(type)) return Response.json({ error: 'not_found' }, { status: 404, headers });
  const response = new Response(request.method === 'HEAD' ? null : asset.body, asset);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}
