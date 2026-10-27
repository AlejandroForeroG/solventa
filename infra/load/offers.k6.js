import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:8787';
const COOKIE = __ENV.COOKIE || '';
const QUOTE_ID = __ENV.QUOTE_ID || '';
const COOKIE_NAME = __ENV.COOKIE_NAME || 'solventa-session';
if (!COOKIE) throw new Error('Set COOKIE to a logged-in web session');
if (!/^COT-\d{4}-\d{5}$/.test(QUOTE_ID)) throw new Error('Set QUOTE_ID to a quote owned by that session');
const ORIGIN = __ENV.ORIGIN || BASE_URL.replace('host.docker.internal', 'localhost');
const ORIGIN_HOST = ORIGIN.replace(/^https?:\/\//, '');
const RATE = Number(__ENV.RATE || 10);
const DURATION = __ENV.DURATION || '60s';
const REPLAY_EVERY = Number(__ENV.REPLAY_EVERY || 10);

const created = new Counter('offers_created');
const replayed = new Counter('offers_replayed');
const preliminary = new Counter('offers_preliminary');

export const options = {
  scenarios: {
    warmup: { executor: 'constant-arrival-rate', rate: Math.max(1, Math.floor(RATE / 5)), timeUnit: '1s', duration: '10s', preAllocatedVUs: 10, maxVUs: 50, exec: 'offer', tags: { phase: 'warmup' } },
    measure: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, startTime: '10s', preAllocatedVUs: 30, maxVUs: 200, exec: 'offer', tags: { phase: 'measure' } }
  },
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<400', 'p(99)<800'],
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'checks{phase:measure}': ['rate>0.99']
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
};

let previousKey = null;

export function offer() {
  const repeat = previousKey && __ITER % REPLAY_EVERY === 0;
  const key = repeat ? previousKey : `offer-load-${__VU}-${__ITER}-${Date.now()}`;
  previousKey = key;
  const response = http.post(`${BASE_URL}/api/v1/quotes/${QUOTE_ID}/offers`, '{}', {
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      origin: ORIGIN,
      host: ORIGIN_HOST
    },
    cookies: { [COOKIE_NAME]: COOKIE }
  });
  const body = (() => { try { return response.json(); } catch { return null; } })();
  const expected = repeat ? 200 : 201;
  const ok = check(response, {
    [`status ${expected}`]: r => r.status === expected,
    'has offer contract': () => body !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.offerId || '') && body.quoteId === QUOTE_ID && ['preliminary', 'definitive'].includes(body.status),
    'has trace id header': r => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.headers['X-Trace-Id'] || '')
  });
  if (ok) {
    (repeat ? replayed : created).add(1);
    if (body.status === 'preliminary') preliminary.add(1);
  }
}

export function handleSummary(data) {
  const trend = data.metrics['http_req_duration{phase:measure}'];
  const pick = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'].map(k => `${k}=${trend ? trend.values[k].toFixed(1) : 'n/a'}ms`).join('  ');
  return {
    '/load/results/last-offer-run.json': JSON.stringify(data, null, 2),
    stdout: `\nmeasured offer profiling at ${RATE} req/s for ${DURATION}: ${pick}\n`
  };
}
