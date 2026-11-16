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

// A customer asks for assistance on site from one provider of the directory, naming where. The request is stored and can be read back by its owner.
export const assistanceRequestsPath = '/api/v1/assistance/requests';
export const assistanceRequestCreateOperation = 'assistance-requests:create';
export const assistanceRequestReadOperation = 'assistance-requests:read';
const referencePattern = /^ASI-[0-9A-HJKMNP-TV-Z]{8}$/;

export type AssistanceRequestBody = {
  providerId: string;
  place: { kind: 'device'; authorized: true; coordinates: { latitude: number; longitude: number } } | { kind: 'address'; address: string };
};
export type AssistanceRequestPlace = { kind: 'device'; latitude: number; longitude: number } | { kind: 'address'; address: string };
export type AssistanceRequestView = {
  id: string;
  reference: string;
  status: 'requested';
  provider: Omit<AssistanceProviderMatch, 'distanceKm'>;
  place: AssistanceRequestPlace;
  createdAt: string;
};

// A device position needs the explicit authorization; a typed address is confirmed by sending it. Nothing else is accepted.
export function parseAssistanceRequestBody(value: unknown): AssistanceRequestBody | null {
  if (!assistanceRecord(value) || Object.keys(value).length !== 2 || typeof value.providerId !== 'string' || !/^demo-[a-z0-9-]{1,48}$/.test(value.providerId)
    || !assistanceRecord(value.place)) return null;
  const place = value.place;
  if (place.kind === 'device' && Object.keys(place).length === 3 && place.authorized === true && assistanceRecord(place.coordinates)
    && Object.keys(place.coordinates).length === 2 && coordinate(place.coordinates.latitude, 90) && coordinate(place.coordinates.longitude, 180)) {
    return { providerId: value.providerId, place: { kind: 'device', authorized: true,
      coordinates: { latitude: place.coordinates.latitude, longitude: place.coordinates.longitude } } };
  }
  if (place.kind === 'address' && Object.keys(place).length === 2 && typeof place.address === 'string') {
    const address = place.address.trim();
    if (address.length >= 2 && address.length <= 160 && !/\p{Cc}/u.test(address)) return { providerId: value.providerId, place: { kind: 'address', address } };
  }
  return null;
}

function view(value: unknown): AssistanceRequestView | null {
  if (!assistanceRecord(value) || Object.keys(value).length !== 6) return null;
  const { id, reference, status, provider, place, createdAt } = value;
  const found = match(provider);
  if (typeof id !== 'string' || !uuid.test(id) || typeof reference !== 'string' || !referencePattern.test(reference) || status !== 'requested'
    || !found || found.distanceKm !== undefined || !assistanceRecord(place)
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;
  let parsedPlace: AssistanceRequestPlace | null = null;
  if (place.kind === 'device' && Object.keys(place).length === 3 && coordinate(place.latitude, 90) && coordinate(place.longitude, 180)) {
    parsedPlace = { kind: 'device', latitude: place.latitude, longitude: place.longitude };
  } else if (place.kind === 'address' && Object.keys(place).length === 2 && boundedText(place.address)) parsedPlace = { kind: 'address', address: place.address };
  if (!parsedPlace) return null;
  const provider2: Omit<AssistanceProviderMatch, 'distanceKm'> = { id: found.id, kind: found.kind, name: found.name, city: found.city, address: found.address, phone: found.phone, hours: found.hours };
  return { id: id.toLowerCase(), reference, status: 'requested', provider: provider2, place: parsedPlace, createdAt };
}

// Responses are checked again by the client: what it shows as a confirmed request must have the shape the server promises.
export function parseAssistanceRequestResponse(value: unknown): AssistanceRequestView | null {
  if (!assistanceRecord(value) || Object.keys(value).length !== 3 || value.simulated !== true || typeof value.traceId !== 'string' || !uuid.test(value.traceId)) return null;
  return view(value.request);
}

export function parseAssistanceRequestList(value: unknown): AssistanceRequestView[] | null {
  if (!assistanceRecord(value) || Object.keys(value).length !== 3 || value.simulated !== true || typeof value.traceId !== 'string' || !uuid.test(value.traceId)
    || !Array.isArray(value.requests) || value.requests.length > 20) return null;
  const requests: AssistanceRequestView[] = [];
  for (const entry of value.requests) {
    const parsed = view(entry);
    if (!parsed) return null;
    requests.push(parsed);
  }
  return requests;
}
