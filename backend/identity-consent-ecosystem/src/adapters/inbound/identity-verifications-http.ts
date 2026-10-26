import type { Hono } from 'hono';
import type { ApiOperation, AccessDecision } from '../../application/api-access';
import type { VerifiedIdentity } from '../../application/authentication';
import type { IdentityVerifications } from '../../application/identity-verifications';
import type { SecurityDecisions } from '../../application/security-decisions';
import { VerificationFailure, verificationSteps } from '../../domain/identity-verification';
import type { VerificationStep } from '../../domain/identity-verification';
import type { MobileAuthenticationDependencies } from './mobile-authentication-http';

export type VerificationAccess = (identity: VerifiedIdentity, operation: ApiOperation) => Promise<AccessDecision>;
const base = '/api/v1/mobile/identity-verifications';
const tracePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const casePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.match(/^application\/json(?:\s*;.*)?$/i)) throw new VerificationFailure('invalid_request', 400);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new VerificationFailure('invalid_request', 400);
  if (!request.body) throw new VerificationFailure('invalid_request', 400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) throw new VerificationFailure('invalid_request', 400);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!object(value)) throw new VerificationFailure('invalid_request', 400);
      return value;
    };
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VerificationFailure('invalid_request', 400)), 5000);
    })]);
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    throw new VerificationFailure('invalid_request', 400);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function mountIdentityVerifications(app: Hono<{ Bindings: IdentityEnv }>, deps: {
  mobile: MobileAuthenticationDependencies | null; application?: IdentityVerifications; authorize?: VerificationAccess;
  security?: Pick<SecurityDecisions, 'deny'>;
}) {
  for (const path of [base, base + '/*']) app.all(path, async c => {
    const supplied = c.req.header('X-Trace-Id') ?? '';
    const traceId = tracePattern.test(supplied) ? supplied.toLowerCase() : crypto.randomUUID();
    c.header('X-Trace-Id', traceId);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const operation = c.req.method === 'GET' ? 'identity-verifications:read' : 'identity-verifications:write';
    const deny = async (cause: 'unauthorized' | 'forbidden') => {
      if (!deps.security) throw new Error('security_recording_unavailable');
      await deps.security.deny({ category: 'api_access', channel: 'mobile', operation, cause }, traceId);
    };
    const respond = (body: object, status: 200 | 201 | 400 | 401 | 403 | 404 | 405 | 409 | 503) => {
      if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="solventa"');
      return c.json({ ...body, traceId }, status);
    };
    try {
      const suffix = c.req.path.slice(base.length);
      const segments = suffix.split('/').filter(Boolean);
      const readOnly = segments.length === 1 && ['terms', 'fixtures'].includes(segments[0]);
      const root = segments.length === 0;
      const stepRoute = segments.length === 3 && segments[1] === 'steps' && verificationSteps.some(step => step === segments[2]);
      const action = segments.length === 2 && ['evaluate', 'assistance', 'revoke'].includes(segments[1]) ? segments[1] : null;
      if (!root && !readOnly && !stepRoute && !action) return respond({ error: 'not_found' }, 404);
      const methods = root ? ['GET', 'POST'] : readOnly ? ['GET'] : stepRoute ? ['PUT'] : ['POST'];
      if (!methods.includes(c.req.method)) { c.header('Allow', methods.join(', ')); return respond({ error: 'method_not_allowed' }, 405); }
      if (c.req.header('Cookie') !== undefined) return respond({ error: 'invalid_request' }, 400);
      if (!deps.mobile || !deps.application || !deps.authorize) return respond({ error: 'access_unavailable' }, 503);
      const token = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
      if (!token || token.length > 8192) {
        await deny('unauthorized'); c.header('WWW-Authenticate', 'Bearer realm="solventa"');
        return respond({ error: 'unauthorized' }, 401);
      }
      const identity = await deps.mobile.provider.authenticate(token);
      if (!identity) { await deny('unauthorized'); return respond({ error: 'unauthorized' }, 401); }
      const access = await deps.authorize(identity, operation);
      if (!access.allowed) {
        if (access.status === 401 || access.status === 403) await deny(access.status === 401 ? 'unauthorized' : 'forbidden');
        return respond({ error: access.error }, access.status);
      }
      if (access.actor.kind !== 'user' || access.actor.channel !== 'mobile' || !access.actor.operations.includes(operation)) {
        await deny('forbidden'); return respond({ error: 'forbidden' }, 403);
      }
      const url = new URL(c.req.url);
      if (readOnly && segments[0] === 'terms') {
        const locale = url.searchParams.get('locale') ?? 'es-CO';
        if ((locale !== 'es-CO' && locale !== 'en-US') || [...url.searchParams.keys()].some(key => key !== 'locale') || url.searchParams.getAll('locale').length > 1) return respond({ error: 'invalid_request' }, 400);
        return respond({ terms: await deps.application.terms(locale) }, 200);
      }
      if (url.search) return respond({ error: 'invalid_request' }, 400);
      if (readOnly) return respond({ fixtures: deps.application.fixtures() }, 200);
      if (root && c.req.method === 'GET') return respond({ verification: await deps.application.inspect(identity, traceId) }, 200);
      const caseId = root ? '' : segments[0].toLowerCase();
      if (!root && !casePattern.test(caseId)) return respond({ error: 'invalid_request' }, 400);
      const key = c.req.header('Idempotency-Key') ?? '';
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return respond({ error: 'invalid_request' }, 400);
      const context = { identity, traceId, caseId, key };
      const body = await bodyOf(c.req.raw);
      if (root) {
        if (!keys(body, ['textVersion', 'locale']) || typeof body.textVersion !== 'number' || !Number.isSafeInteger(body.textVersion) || body.textVersion < 1 || (body.locale !== 'es-CO' && body.locale !== 'en-US')) return respond({ error: 'invalid_request' }, 400);
        return respond({ verification: await deps.application.grant(context, { textVersion: Number(body.textVersion), locale: body.locale }) }, 201);
      }
      if (action === 'revoke') {
        if (!keys(body, [])) return respond({ error: 'invalid_request' }, 400);
        return respond({ verification: await deps.application.revoke(context) }, 200);
      }
      const expected = stepRoute ? ['reference', 'sha256', 'corpusVersion', 'expectedVersion'] : ['expectedVersion'];
      if (!keys(body, expected) || typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) return respond({ error: 'invalid_request' }, 400);
      if (stepRoute) {
        if (typeof body.reference !== 'string' || typeof body.sha256 !== 'string' || typeof body.corpusVersion !== 'string') return respond({ error: 'invalid_request' }, 400);
        return respond({ verification: await deps.application.saveStep(context, segments[2] as VerificationStep,
          { reference: body.reference, sha256: body.sha256, corpusVersion: body.corpusVersion }, body.expectedVersion) }, 200);
      }
      const verification = action === 'evaluate' ? await deps.application.evaluate(context, body.expectedVersion)
        : await deps.application.requestAssistance(context, body.expectedVersion);
      return verification.status === 'unavailable' && action === 'evaluate'
        ? respond({ error: 'verification_unavailable', verification }, 503) : respond({ verification }, 200);
    } catch (error) {
      if (error instanceof VerificationFailure) {
        try { if (error.status === 404 || error.status === 401 || error.code === 'consent_inactive') await deny(error.status === 401 ? 'unauthorized' : 'forbidden'); }
        catch { return respond({ error: 'access_unavailable' }, 503); }
        return respond({ error: error.code }, error.status);
      }
      return respond({ error: 'access_unavailable' }, 503);
    } finally {
      if (c.req.raw.body && !c.req.raw.bodyUsed) await c.req.raw.body.cancel().catch(() => {});
    }
  });
}
