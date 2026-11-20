import http from 'k6/http';
import { check } from 'k6';

const base = __ENV.BASE_URL || 'http://host.docker.internal:8787';
const claimId = __ENV.CLAIM_ID || '';
const number = __ENV.CLAIM_NUMBER || '';
const cookie = __ENV.COOKIE || '';
const bearer = __ENV.BEARER || '';
const cookieName = __ENV.COOKIE_NAME || 'solventa-session';
const rate = Number(__ENV.RATE || 10);
const duration = __ENV.DURATION || '60s';
if (!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(claimId) || !/^SIN-\d{4}-\d{5}$/.test(number)) {
  throw Error('Set CLAIM_ID and CLAIM_NUMBER to one owned, submitted synthetic claim');
}
if (Boolean(cookie) === Boolean(bearer)) throw Error('Set exactly one owner credential: COOKIE or BEARER');
if (!Number.isInteger(rate) || rate < 1) throw Error('Set RATE to a positive integer');

export const options = {
  scenarios: {
    warmup: { executor: 'constant-arrival-rate', rate: Math.max(1, Math.floor(rate / 5)), timeUnit: '1s', duration: '10s',
      preAllocatedVUs: 4, maxVUs: 20, tags: { phase: 'warmup' } },
    measure: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration, startTime: '10s',
      preAllocatedVUs: 10, maxVUs: 40, tags: { phase: 'measure' } },
  },
  thresholds: {
    'http_req_duration{phase:measure}': ['p(95)<=150', 'p(99)<=300'],
    'http_req_failed{phase:measure}': ['rate==0'],
    'checks{phase:measure}': ['rate==1'],
    'dropped_iterations{phase:measure}': ['count==0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const path = bearer ? '/native/cases/' + claimId : '/' + claimId + '/customer';
  const auth = bearer ? { headers: { Authorization: 'Bearer ' + bearer } } : { cookies: { [cookieName]: cookie } };
  const response = http.get(base + '/api/v1/claims' + path, { ...auth, redirects: 0, tags: { name: 'owned-claim-detail' } });
  check(response, {
    'owned claim read succeeded': reply => reply.status === 200,
    'expected customer projection': reply => {
      if (reply.status !== 200) return false;
      const body = reply.json();
      return body.claimNumber === number && body.access === 'customer' && Array.isArray(body.history) && Array.isArray(body.requirements);
    },
  });
}
