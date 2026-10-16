import type { SignalProvider } from '../../application/ports/signal-sources';
import { AggregatorSignalProvider, simulatedAggregatorSource } from './aggregator-signal-provider';
import { DirectSignalProvider, simulatedDirectSource } from './direct-signal-provider';

// Values accepted in SIGNAL_PROVIDER. A real provider adds an entry with its own source; the core does not change.
const PROVIDERS: Record<string, (name: string, now: () => Date) => SignalProvider> = {
  direct_simulated: (name, now) => new DirectSignalProvider(name, simulatedDirectSource(now)),
  aggregator_simulated: (name, now) => new AggregatorSignalProvider(name, simulatedAggregatorSource(now))
};

export function signalProviderFor(name: string | undefined, now = () => new Date()): SignalProvider | null {
  return name !== undefined && Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name](name, now) : null;
}
