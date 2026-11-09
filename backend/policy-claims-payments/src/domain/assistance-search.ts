export type Coordinates = { latitude: number; longitude: number };

export type AssistanceProvider = {
  id: string;
  kind: 'workshop' | 'expert' | 'roadside';
  name: string;
  city: string;
  address: string;
  phone: string;
  hours: string;
  coordinates: Coordinates;
};

export type AssistanceSearch =
  | { kind: 'manual'; query: string }
  | { kind: 'nearby'; coordinates: Coordinates };

export type AssistanceMatch = Omit<AssistanceProvider, 'coordinates'> & { distanceKm?: number };

export function validCoordinates(value: Coordinates): boolean {
  return Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}

function normalizePlace(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function distanceKm(from: Coordinates, to: Coordinates): number {
  const radians = Math.PI / 180;
  const a = Math.sin((to.latitude - from.latitude) * radians / 2) ** 2
    + Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians)
      * Math.sin((to.longitude - from.longitude) * radians / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

export function findAssistanceProviders(
  search: AssistanceSearch,
  providers: readonly AssistanceProvider[],
): AssistanceMatch[] | null {
  if (search.kind === 'nearby' && !validCoordinates(search.coordinates)) return null;
  const query = search.kind === 'manual' ? normalizePlace(search.query) : '';
  if (search.kind === 'manual' && (query.length < 2 || search.query.length > 160)) return null;

  const matches: AssistanceMatch[] = [];
  for (const { coordinates, ...provider } of providers) {
    if (search.kind === 'nearby') {
      const distance = distanceKm(search.coordinates, coordinates);
      if (distance <= 25) matches.push({ ...provider, distanceKm: distance });
    } else if ([provider.city, provider.address, provider.address + ', ' + provider.city]
      .some(place => normalizePlace(place) === query)) {
      matches.push(provider);
    }
  }
  return matches.sort((left, right) =>
    (left.distanceKm ?? 0) - (right.distanceKm ?? 0) || left.id.localeCompare(right.id));
}
