import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:8787';
const COOKIE = __ENV.COOKIE || '';
const POLICY_ID = __ENV.POLICY_ID || '';
const COOKIE_NAME = __ENV.COOKIE_NAME || 'solventa-session';
if (!COOKIE) throw new Error('Set COOKIE to a logged-in web session');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(POLICY_ID)) throw new Error('Set POLICY_ID to an issued policy owned by that session');
const RATE = Number(__ENV.RATE || 10);
const DURATION = __ENV.DURATION || '60s';

const details = new Counter('policy_details_read');

export const options = {
  scenarios: {
    warmup: { executor: 'constant-arrival-rate', rate: Math.max(1, Math.floor(RATE / 5)), timeUnit: '1s', duration: '10s', preAllocatedVUs: 10, maxVUs: 50, exec: 'detail', tags: { phase: 'warmup' } },
    measure: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, startTime: '10s', preAllocatedVUs: 30, maxVUs: 200, exec: 'detail', tags: { phase: 'measure' } }
  },
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<=150', 'p(99)<=300'],
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'checks{phase:measure}': ['rate>0.99']
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
};

export function detail() {
  const response = http.get(`${BASE_URL}/api/v1/policies/${POLICY_ID}/detail`, { cookies: { [COOKIE_NAME]: COOKIE } });
  const body = (() => { try { return response.json(); } catch { return null; } })();
  const ok = check(response, {
    'status 200': r => r.status === 200,
    'has detail contract': () => body !== null && body.policyId === POLICY_ID && Array.isArray(body.exclusions) && Array.isArray(body.documents) && Array.isArray(body.payments),
    'has trace id header': r => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.headers['X-Trace-Id'] || '')
  });
  if (ok) details.add(1);
}

export function handleSummary(data) {
  const trend = data.metrics['http_req_duration{phase:measure}'];
  const pick = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'].map(k => `${k}=${trend ? trend.values[k].toFixed(1) : 'n/a'}ms`).join('  ');
  return {
    '/load/results/last-policy-run.json': JSON.stringify(data, null, 2),
    stdout: `\nmeasured policy detail at ${RATE} req/s for ${DURATION}: ${pick}\n`
  };
}
