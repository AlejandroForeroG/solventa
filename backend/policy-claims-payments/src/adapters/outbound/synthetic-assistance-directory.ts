import { findAssistanceProviders, validCoordinates } from '../../domain/assistance-search';
import type { AssistanceDirectoryResult, AssistanceProvider, AssistanceSearch } from '../../domain/assistance-search';

export const syntheticAssistanceFormat = 'synthetic-assistance-directory.v1';

export const syntheticAssistanceDirectory = {
  formatVersion: syntheticAssistanceFormat,
  simulated: true,
  providers: [
    { id: 'demo-bog-workshop', kind: 'workshop', name: 'Taller de prueba Bogotá', city: 'Bogotá',
      address: 'Calle de prueba 10', phone: '+570000000001', hours: 'Lun–vie 08:00–17:00',
      coordinates: { latitude: 4.648, longitude: -74.098 } },
    { id: 'demo-bog-expert', kind: 'expert', name: 'Peritaje de prueba Bogotá', city: 'Bogotá',
      address: 'Calle de prueba 20', phone: '+570000000002', hours: 'Lun–vie 09:00–17:00',
      coordinates: { latitude: 4.71, longitude: -74.072 } },
    { id: 'demo-med-roadside', kind: 'roadside', name: 'Asistencia de prueba Medellín', city: 'Medellín',
      address: 'Calle de prueba 30', phone: '+570000000003', hours: 'Todos los días 00:00–24:00',
      coordinates: { latitude: 6.244, longitude: -75.581 } },
  ] satisfies AssistanceProvider[],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

function parseProvider(value: unknown): AssistanceProvider | null {
  if (!record(value)) return null;
  const { id, kind, name, city, address, phone, hours, coordinates } = value;
  if (Object.keys(value).length !== 8
    || typeof id !== 'string' || !/^demo-[a-z0-9-]{1,48}$/.test(id)
    || (kind !== 'workshop' && kind !== 'expert' && kind !== 'roadside')
    || !boundedText(name) || !boundedText(city) || !boundedText(address) || !boundedText(hours)
    || typeof phone !== 'string' || !/^\+570{8}[0-9]{2}$/.test(phone)
    || !record(coordinates) || Object.keys(coordinates).length !== 2
    || typeof coordinates.latitude !== 'number' || typeof coordinates.longitude !== 'number') return null;
  const point = { latitude: coordinates.latitude, longitude: coordinates.longitude };
  if (!validCoordinates(point)) return null;
  return { id, kind, name, city, address, phone, hours, coordinates: point };
}

export function searchSyntheticAssistance(
  search: AssistanceSearch,
  payload: unknown = syntheticAssistanceDirectory,
): AssistanceDirectoryResult {
  if (!record(payload) || Object.keys(payload).length !== 3
    || payload.formatVersion !== syntheticAssistanceFormat || payload.simulated !== true
    || !Array.isArray(payload.providers) || payload.providers.length > 100) return { status: 'unavailable' };

  const providers: AssistanceProvider[] = [];
  const ids = new Set<string>();
  for (const raw of payload.providers) {
    const provider = parseProvider(raw);
    if (!provider || ids.has(provider.id)) return { status: 'unavailable' };
    ids.add(provider.id);
    providers.push(provider);
  }
  const matches = findAssistanceProviders(search, providers);
  return matches ? { status: 'ok', simulated: true, providers: matches } : { status: 'invalid_input' };
}

export function listSyntheticExperts() {
  return syntheticAssistanceDirectory.providers.filter(provider => provider.kind === 'expert').map(({ id, name }) => ({ id, name }));
}
