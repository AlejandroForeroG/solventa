import type { AssistanceMatch } from './assistance-search';

// A customer's request for assistance on site. The only state today is 'requested': the provider is simulated and its answer is not.
export type AssistancePlace = { kind: 'device'; latitude: number; longitude: number } | { kind: 'address'; address: string };
export type AssistanceRequestRecord = {
  id: string;
  reference: string;
  status: 'requested';
  provider: Omit<AssistanceMatch, 'distanceKm'>;
  place: AssistancePlace;
  createdAt: string;
};

// The request as the edge validated it: a device position was authorized explicitly, and an address was confirmed by sending it.
export type AssistanceRequestInput = { providerId: string; place: AssistancePlace };

export const MAX_LISTED_REQUESTS = 20;

// Coordinates keep six decimals, like the claim report: about ten centimetres, more than a roadside call needs.
export const roundCoordinate = (value: number) => Math.round(value * 1e6) / 1e6;

// The same request yields the same text, so hashing it recognizes a retry and not an altered request under the same key.
export function canonicalAssistanceRequest(providerId: string, place: AssistancePlace): string {
  return JSON.stringify(['assistance-request.v1', providerId, place.kind === 'device' ? ['device', place.latitude, place.longitude] : ['address', place.address]]);
}
