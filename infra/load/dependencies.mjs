import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENT = 'mortgage_offer_profiled';

export const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];

// Reads the backend log (wrangler prefixes each line with the Worker name) and keeps the profiling lines that carry timings.
export function parseProfiles(text) {
  return text.split('\n').filter(line => line.includes(EVENT)).flatMap(line => {
    try {
      const profile = JSON.parse(line.slice(line.indexOf('{')));
      return profile.event === EVENT && Array.isArray(profile.dependencies) ? [profile] : [];
    } catch { return []; }
  });
}

const spread = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
};

export function summarize(profiles) {
  const byName = new Map();
  const entry = name => byName.get(name) ?? byName.set(name, { durations: [], errors: 0, dominantIn: 0 }).get(name);
  for (const { dominant, dependencies } of profiles) {
    for (const call of dependencies) {
      const row = entry(call.name);
      row.durations.push(call.durationMs);
      if (call.outcome === 'failed') row.errors++;
    }
    if (dominant) entry(dominant).dominantIn++;
  }
  const dependencies = [...byName].map(([name, { durations, errors, dominantIn }]) => ({ name, calls: durations.length, errors, dominantIn, ...spread(durations) }))
    .sort((a, b) => b.p95 - a.p95 || a.name.localeCompare(b.name));
  return { requests: profiles.length, total: profiles.length ? spread(profiles.map(profile => profile.latencyMs)) : null, dependencies };
}

export function table({ requests, total, dependencies }) {
  const header = ['dependency', 'calls', 'errors', 'p50 ms', 'p95 ms', 'p99 ms', 'dominant in'];
  const rows = dependencies.map(d => [d.name, d.calls, d.errors, d.p50, d.p95, d.p99, d.dominantIn]);
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map(row => String(row[i]).length)));
  const line = cells => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  const totalLine = total ? `${requests} profiled offers, end to end: p50 ${total.p50} ms, p95 ${total.p95} ms, p99 ${total.p99} ms` : 'no profiled offers with timings found';
  return [totalLine, '', line(header), ...rows.map(line)].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file] = process.argv.slice(2);
  if (!file) { console.error('Usage: node infra/load/dependencies.mjs <backend log file>'); process.exit(2); }
  console.log(table(summarize(parseProfiles(readFileSync(file, 'utf8')))));
}
