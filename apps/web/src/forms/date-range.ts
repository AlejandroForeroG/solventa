const iso = /^\d{4}-\d{2}-\d{2}$/;
const valid = (value: string) => iso.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export type DateRangeProblem = { field: 'from' | 'to'; reason: 'invalid' | 'inverted' | 'tooLong' } | null;

export function dateRangeProblem(from: string, to: string, maxDays?: number): DateRangeProblem {
  if (from && !valid(from)) return { field: 'from', reason: 'invalid' };
  if (to && !valid(to)) return { field: 'to', reason: 'invalid' };
  if (from && to && to < from) return { field: 'to', reason: 'inverted' };
  if (maxDays && from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > maxDays) return { field: 'to', reason: 'tooLong' };
  return null;
}
