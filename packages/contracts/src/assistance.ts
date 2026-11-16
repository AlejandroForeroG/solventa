export const assistanceSearchPath = '/api/v1/assistance/providers/search';
export const assistanceOperation = 'assistance-providers:read';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AssistanceSearchRequest =
  | { kind: 'manual'; query: string }
  | { kind: 'nearby'; locationAuthorized: true; coordinates: { latitude: number; longitude: number } };

export type AssistanceProviderMatch = {
  id: string;
  kind: 'workshop' | 'expert' | 'roadside';
  name: string;
  city: string;
  address: string;
  phone: string;
  hours: string;
  distanceKm?: number;
};

export function assistanceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coordinate(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
}

export function parseAssistanceSearch(value: unknown): AssistanceSearchRequest | null {
  if (!assistanceRecord(value)) return null;
  if (value.kind === 'manual' && Object.keys(value).length === 2 && typeof value.query === 'string'
    && value.query.length <= 160 && value.query.trim().length >= 2) {
    return { kind: 'manual', query: value.query.trim() };
  }
  if (value.kind === 'nearby' && Object.keys(value).length === 3 && value.locationAuthorized === true
    && assistanceRecord(value.coordinates) && Object.keys(value.coordinates).length === 2
    && coordinate(value.coordinates.latitude, 90) && coordinate(value.coordinates.longitude, 180)) {
    return { kind: 'nearby', locationAuthorized: true,
      coordinates: { latitude: value.coordinates.latitude, longitude: value.coordinates.longitude } };
  }
  return null;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

function match(value: unknown): AssistanceProviderMatch | null {
  if (!assistanceRecord(value)) return null;
  const { id, kind, name, city, address, phone, hours, distanceKm } = value;
  if (Object.keys(value).length !== (distanceKm === undefined ? 7 : 8)
    || typeof id !== 'string' || !/^demo-[a-z0-9-]{1,48}$/.test(id)
    || (kind !== 'workshop' && kind !== 'expert' && kind !== 'roadside')
    || !boundedText(name) || !boundedText(city) || !boundedText(address) || !boundedText(hours)
    || typeof phone !== 'string' || !/^\+570{8}[0-9]{2}$/.test(phone)
    || (distanceKm !== undefined && (!coordinate(distanceKm, 25) || distanceKm < 0))) return null;
  return { id, kind, name, city, address, phone, hours, ...(distanceKm === undefined ? {} : { distanceKm }) };
}

export function parseAssistanceResults(value: unknown): AssistanceProviderMatch[] | null {
  if (!assistanceRecord(value) || Object.keys(value).length !== 3 || value.simulated !== true
    || typeof value.traceId !== 'string' || !uuid.test(value.traceId)
    || !Array.isArray(value.providers) || value.providers.length > 100) return null;
  const results: AssistanceProviderMatch[] = [];
  const seen = new Set<string>();
  for (const entry of value.providers) {
    const provider = match(entry);
    if (!provider || seen.has(provider.id)) return null;
    seen.add(provider.id);
    results.push(provider);
  }
  return results;
}
