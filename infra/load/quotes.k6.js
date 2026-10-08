import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Set COOKIE (a logged-in user's session: POST /api/v1/me/quotes) or TOKEN (partner access token: POST /api/v1/quotes).
// Optional: BASE_URL, RATE, DURATION, REPLAY_EVERY. See README.md. Thresholds: p95 <= 250 ms, p99 <= 500 ms.
const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:8787';
const COOKIE = __ENV.COOKIE || '';
const TOKEN = __ENV.TOKEN || '';
const COOKIE_NAME = (__ENV.COOKIE_NAME || 'solventa-session');
if (!COOKIE && !TOKEN) throw new Error('Set COOKIE (web user session) or TOKEN (partner access token)');
const PATH = COOKIE ? '/api/v1/me/quotes' : '/api/v1/quotes';
const ORIGIN = __ENV.ORIGIN || BASE_URL.replace('host.docker.internal', 'localhost');
const RATE = Number(__ENV.RATE || 30);
const DURATION = __ENV.DURATION || '60s';
const REPLAY_EVERY = Number(__ENV.REPLAY_EVERY || 10);

const created = new Counter('quotes_created');
const replayed = new Counter('quotes_replayed');

export const options = {
  scenarios: {
    // Short low-rate phase so connections, JIT and pools are warm before measuring.
    warmup: { executor: 'constant-arrival-rate', rate: Math.max(1, Math.floor(RATE / 5)), timeUnit: '1s', duration: '10s', preAllocatedVUs: 10, maxVUs: 50, exec: 'quote', tags: { phase: 'warmup' } },
    measure: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, startTime: '10s', preAllocatedVUs: 50, maxVUs: 300, exec: 'quote', tags: { phase: 'measure' } }
  },
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<250', 'p(99)<500'],
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'checks{phase:measure}': ['rate>0.99']
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']
};

const digits = n => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
let previous = null;

function newRequest() {
  const year = 1960 + Math.floor(Math.random() * 45); // ages 21 to 65 for every run date
  return {
    key: `load-${__VU}-${__ITER}-${Date.now()}-${digits(6)}`,
    body: JSON.stringify({
      product: 'vida_hipotecario',
      customer: { fullName: 'Cliente Sintetico Carga', documentType: 'CC', documentNumber: '1' + digits(9), birthDate: `${year}-06-15`, city: 'Bogotá D.C.' },
      credit: { partnerCreditId: `CRE-LOAD-${digits(6)}`, amount: 50000000 + Math.floor(Math.random() * 400) * 1000000, termMonths: 12 + Math.floor(Math.random() * 229) }
    })
  };
}

export function quote() {
  const repeat = previous && __ITER % REPLAY_EVERY === 0;
  const request = repeat ? previous : newRequest();
  previous = request;
  const response = http.post(`${BASE_URL}${PATH}`, request.body, {
    headers: { 'content-type': 'application/json', 'idempotency-key': request.key, ...(COOKIE ? { cookie: `${COOKIE_NAME}=${COOKIE}`, origin: ORIGIN } : { authorization: `Bearer ${TOKEN}` }) }
  });
  const expected = repeat ? 200 : 201;
  const ok = check(response, {
    [`status ${expected}`]: r => r.status === expected,
    'has quote id and COP': r => { try { const b = r.json(); return /^COT-\d{4}-\d{5}$/.test(b.quoteId) && b.currency === 'COP'; } catch { return false; } },
    'has trace id header': r => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.headers['X-Trace-Id'] || '')
  });
  if (ok) (repeat ? replayed : created).add(1);
}

export function handleSummary(data) {
  const trend = data.metrics['http_req_duration{phase:measure}'];
  const pick = ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'].map(k => `${k}=${trend ? trend.values[k].toFixed(1) : 'n/a'}ms`).join('  ');
  const line = `measured ${RATE} req/s for ${DURATION}: ${pick}`;
  return { '/load/results/last-run.json': JSON.stringify(data, null, 2), stdout: `\n${line}\n` };
}
