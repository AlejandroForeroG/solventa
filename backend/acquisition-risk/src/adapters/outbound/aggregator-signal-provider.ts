import type { Signal, SignalScope } from '../../domain/signal';
import { ProviderFailure } from '../../application/ports/signal-sources';
import type { ProviderFailureCode, SignalProvider } from '../../application/ports/signal-sources';
import { callProvider, DEFAULT_DEADLINE_MS, invalidResponse, isCount, record, signalOf } from './signal-provider-call';
import type { ProviderSource, SignalData } from './signal-provider-call';

// One aggregator resells every source behind a common envelope (format version 1). It reports
// its own business errors inside a 200 response, so the envelope state is checked before the data.
const SOURCES: Record<SignalScope, string> = {
  income_obligations_12m: 'bancolombia',
  payment_history_score: 'datacredito',
  affiliation_regime: 'ruaf',
  identity_validation: 'registraduria'
};
const STATE_FAILURES = new Map<unknown, ProviderFailureCode>([['SIN_DATOS', 'not_found'], ['ERROR_FUENTE', 'unavailable']]);
const REGIMES = new Map<unknown, SignalData['affiliation_regime']['regime']>([['C', 'contributory'], ['S', 'subsidized'], ['E', 'special']]);

function translate(scope: SignalScope, body: unknown): Signal {
  const envelope = record(body);
  const failure = STATE_FAILURES.get(envelope.estado);
  if (failure) throw new ProviderFailure(failure);
  if (envelope.estado !== 'OK' || envelope.fuente !== SOURCES[scope]) throw invalidResponse();
  const result = record(envelope.resultado);
  const capturedAt = envelope.fecha_corte;
  switch (scope) {
    case 'income_obligations_12m': {
      const { ingresos_promedio_mensual: income, obligaciones_mensuales: obligations } = result;
      if (!isCount(income) || !isCount(obligations)) throw invalidResponse();
      return signalOf(scope, capturedAt, { monthlyIncomeCop: income, monthlyObligationsCop: obligations });
    }
    case 'payment_history_score': {
      const { score, moras_ultimos_12_meses: late } = result;
      if (!isCount(score) || score > 1000 || !isCount(late)) throw invalidResponse();
      return signalOf(scope, capturedAt, { score, latePayments12m: late });
    }
    case 'affiliation_regime': {
      const regime = REGIMES.get(result.regimen_salud);
      if (!regime || typeof result.afiliado_activo !== 'boolean') throw invalidResponse();
      return signalOf(scope, capturedAt, { regime, active: result.afiliado_activo });
    }
    case 'identity_validation':
      if (typeof result.cedula_vigente !== 'boolean') throw invalidResponse();
      return signalOf(scope, capturedAt, { documentValid: result.cedula_vigente });
  }
}

// Synthetic answers for the same fictitious person as the direct simulation; no real source is reached.
const RESULTS: Record<SignalScope, Record<string, unknown>> = {
  income_obligations_12m: { ingresos_promedio_mensual: 4500000, obligaciones_mensuales: 1200000 },
  payment_history_score: { score: 742, moras_ultimos_12_meses: 0 },
  affiliation_regime: { regimen_salud: 'C', afiliado_activo: true },
  identity_validation: { cedula_vigente: true }
};
export const simulatedAggregatorSource: ProviderSource = async scope => ({
  status: 200,
  body: { estado: 'OK', fuente: SOURCES[scope], fecha_corte: '2026-09-30T00:00:00-05:00', resultado: RESULTS[scope] }
});

export class AggregatorSignalProvider implements SignalProvider {
  constructor(private readonly name: string, private readonly source: ProviderSource, private readonly deadlineMs = DEFAULT_DEADLINE_MS) {}

  read(subjectToken: string, scope: SignalScope, traceId: string): Promise<Signal> {
    return callProvider({ provider: this.name, source: this.source, deadlineMs: this.deadlineMs, translate }, subjectToken, scope, traceId);
  }
}
