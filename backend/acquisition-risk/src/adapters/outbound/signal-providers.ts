import type { SignalProvider } from '../../application/ports/signal-sources';
import { AggregatorSignalProvider, simulatedAggregatorSource } from './aggregator-signal-provider';
import { DirectSignalProvider, simulatedDirectSource } from './direct-signal-provider';

// Values accepted in SIGNAL_PROVIDER. A real provider adds an entry with its own source; the core does not change.
const PROVIDERS: Record<string, (name: string) => SignalProvider> = {
  direct_simulated: name => new DirectSignalProvider(name, simulatedDirectSource),
  aggregator_simulated: name => new AggregatorSignalProvider(name, simulatedAggregatorSource)
};

export function signalProviderFor(name: string | undefined): SignalProvider | null {
  return name !== undefined && Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name](name) : null;
}
