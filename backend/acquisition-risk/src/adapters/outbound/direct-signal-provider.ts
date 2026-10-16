import type { Signal, SignalScope } from '../../domain/signal';
import { ProviderFailure } from '../../application/ports/signal-sources';
import type { SignalProvider } from '../../application/ports/signal-sources';
import { callProvider, DEFAULT_DEADLINE_MS, invalidResponse, isCount, record, signalOf } from './signal-provider-call';
import type { ProviderSource, SignalData } from './signal-provider-call';

// Each source is queried separately and answers in its own format (formats version 1).
const REGIMES = new Map<unknown, SignalData['affiliation_regime']['regime']>([['CONTRIBUTIVO', 'contributory'], ['SUBSIDIADO', 'subsidized'], ['ESPECIAL', 'special']]);
const AFFILIATION_STATES = new Map<unknown, boolean>([['ACTIVO', true], ['RETIRADO', false], ['SUSPENDIDO', false]]);
const DOCUMENT_STATES = new Map<unknown, boolean>([['VIGENTE', true], ['CANCELADA', false], ['CANCELADA_POR_MUERTE', false]]);

// Open Finance (Bancolombia): amounts in COP cents over a 12 month period.
function income(body: unknown): Signal {
  const data = record(record(body).data);
  const { incomeMonthlyCents, obligationsMonthlyCents, periodMonths } = data;
  if (!isCount(incomeMonthlyCents) || !isCount(obligationsMonthlyCents) || periodMonths !== 12) throw invalidResponse();
  return signalOf('income_obligations_12m', data.asOf, { monthlyIncomeCop: Math.round(incomeMonthlyCents / 100), monthlyObligationsCop: Math.round(obligationsMonthlyCents / 100) });
}

// Datacrédito Experian.
function paymentHistory(body: unknown): Signal {
  const query = record(record(body).consulta);
  const { puntaje, moras12m } = query;
  if (!isCount(puntaje) || puntaje > 1000 || !isCount(moras12m)) throw invalidResponse();
  return signalOf('payment_history_score', query.fechaConsulta, { score: puntaje, latePayments12m: moras12m });
}

// RUAF: one entry per social security subsystem; only health is authorized.
function affiliation(body: unknown): Signal {
  const reply = record(body);
  if (!Array.isArray(reply.afiliaciones)) throw invalidResponse();
  const health = reply.afiliaciones.map(record).find(entry => entry.subsistema === 'SALUD');
  if (!health) throw new ProviderFailure('not_found');
  const regime = REGIMES.get(health.regimen);
  const active = AFFILIATION_STATES.get(health.estado);
  if (!regime || active === undefined) throw invalidResponse();
  return signalOf('affiliation_regime', reply.fechaCorte, { regime, active });
}

// Registraduría Nacional.
function identity(body: unknown): Signal {
  const reply = record(body);
  if (reply.estadoCedula === 'NO_REGISTRA') throw new ProviderFailure('not_found');
  const verified = DOCUMENT_STATES.get(reply.estadoCedula);
  if (verified === undefined) throw invalidResponse();
  return signalOf('identity_validation', reply.fechaConsulta, { verified });
}

const TRANSLATORS: Record<SignalScope, (body: unknown) => Signal> = {
  income_obligations_12m: income,
  payment_history_score: paymentHistory,
  affiliation_regime: affiliation,
  identity_validation: identity
};

// Synthetic answers for one fictitious person, stamped with the query time; no real source is reached.
function simulatedAnswer(scope: SignalScope, at: string): unknown {
  switch (scope) {
    case 'income_obligations_12m': return { data: { incomeMonthlyCents: 450000000, obligationsMonthlyCents: 120000000, periodMonths: 12, asOf: at } };
    case 'payment_history_score': return { consulta: { puntaje: 742, moras12m: 0, fechaConsulta: at } };
    case 'affiliation_regime': return { fechaCorte: at, afiliaciones: [{ subsistema: 'PENSION', regimen: 'RAIS', estado: 'ACTIVO' }, { subsistema: 'SALUD', regimen: 'CONTRIBUTIVO', estado: 'ACTIVO' }] };
    case 'identity_validation': return { estadoCedula: 'VIGENTE', fechaConsulta: at };
  }
}
export function simulatedDirectSource(now = () => new Date()): ProviderSource {
  return async scope => ({ status: 200, body: simulatedAnswer(scope, now().toISOString()) });
}

export class DirectSignalProvider implements SignalProvider {
  constructor(private readonly name: string, private readonly source: ProviderSource, private readonly deadlineMs = DEFAULT_DEADLINE_MS) {}

  read(subjectToken: string, scope: SignalScope, traceId: string): Promise<Signal> {
    return callProvider({ provider: this.name, source: this.source, deadlineMs: this.deadlineMs, translate: (s, body) => TRANSLATORS[s](body) }, subjectToken, scope, traceId);
  }
}
