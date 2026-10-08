import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const metric = name => data.metrics[name]?.values ?? {};
const latency = metric('http_req_duration{phase:measure}');
const failed = metric('http_req_failed{phase:measure}');
const checks = metric('checks{phase:measure}');
const ms = value => (value === undefined ? 'n/a' : `${value.toFixed(1)} ms`);
const thresholds = Object.fromEntries(Object.entries(data.metrics).flatMap(([name, m]) => Object.entries(m.thresholds ?? {}).map(([rule, t]) => [`${name} ${rule}`, t.ok ? 'PASS' : 'FAIL'])));
console.log(JSON.stringify({
  created: metric('quotes_created').count, replayed: metric('quotes_replayed').count,
  failedRate: failed.rate, checksPassRate: checks.rate,
  latency: { avg: ms(latency.avg), med: ms(latency.med), p90: ms(latency['p(90)']), p95: ms(latency['p(95)']), p99: ms(latency['p(99)']), max: ms(latency.max) },
  thresholds
}, null, 2));
