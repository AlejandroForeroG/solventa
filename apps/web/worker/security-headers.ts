const applicationPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export function withSecurityHeaders(request: Request, response: Response): Response {
  // Binding and asset responses can have immutable headers; preserve their body and repeated cookies.
  const secured = new Response(response.body, response);
  secured.headers.set('x-content-type-options', 'nosniff');
  secured.headers.set('x-frame-options', 'DENY');
  secured.headers.set('referrer-policy', 'no-referrer');
  // The API viewer supplies its own more restrictive policy without external fonts or forms.
  if (!secured.headers.has('content-security-policy')) secured.headers.set('content-security-policy', applicationPolicy);
  if (new URL(request.url).protocol === 'https:') secured.headers.set('strict-transport-security', 'max-age=31536000');
  else secured.headers.delete('strict-transport-security');
  return secured;
}
