import type { ParametricOccurrence } from '../../domain/parametric';

// `content` is the exact text the provider signed; the application fingerprints it to recognise a replay.
export type ProviderEvent = { status: 'verified'; occurrence: ParametricOccurrence; content: string } | { status: 'invalid' };

export interface ParametricEventProvider {
  receive(input: unknown): Promise<ProviderEvent>;
}
