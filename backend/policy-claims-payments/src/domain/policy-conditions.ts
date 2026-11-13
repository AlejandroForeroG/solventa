import type { AcceptedOffer } from './financial';

// The wording is academic demonstration text, kept in es-CO because it is the contract language of the document.
// A policy is joined to the version in force when it was issued, so it is not part of the signed document or its hash.
// A published version is never edited: a change is a new entry with a later `since`, so older policies keep their wording.
export type Exclusion = { code: string; text: string };
export type Clause = { title: string; lines: string[] };
export type ProductConditions = { productName: string; exclusions: Exclusion[]; clauses: Clause[] };
export type ConditionsVersion = { version: string; since: string; products: Record<AcceptedOffer['product'], ProductConditions> };

const mortgageLife: ProductConditions = {
  productName: 'Vida hipotecario',
  exclusions: [
    { code: '7.1', text: 'Actos intencionales del asegurado dirigidos a producir el siniestro.' },
    { code: '7.2', text: 'Participación en actividades bélicas o en operaciones militares declaradas.' },
    { code: '7.3', text: 'Preexistencias conocidas y no declaradas al momento de la suscripción.' },
    { code: '7.4', text: 'Práctica profesional de deportes de alto riesgo no informada.' }
  ],
  clauses: [
    { title: 'Cláusula 1 · Amparos', lines: ['1.1 Fallecimiento del asegurado por cualquier causa, hasta la suma asegurada.'] },
    { title: 'Cláusula 2 · Vigencia', lines: ['2.1 La cobertura rige durante el período indicado en las condiciones particulares.'] },
    { title: 'Cláusula 3 · Pago de la prima', lines: [
      '3.1 La prima se cobra una sola vez al emitir la póliza.',
      '3.2 El cobro queda registrado con un recibo y no genera cargos duplicados.'
    ] }
  ]
};

const flightDelay: ProductConditions = {
  productName: 'Retraso de vuelo',
  exclusions: [
    { code: '7.1', text: 'Retrasos inferiores al umbral de minutos indicado en la cobertura.' },
    { code: '7.2', text: 'Vuelos distintos al vuelo asegurado en la póliza.' },
    { code: '7.3', text: 'Retrasos ocurridos antes de la emisión o fuera de la vigencia.' },
    { code: '7.4', text: 'Retrasos que la fuente de datos de vuelos no verifique.' }
  ],
  clauses: [
    { title: 'Cláusula 1 · Amparos', lines: ['1.1 Pago único cuando el retraso verificado del vuelo asegurado supera el umbral.'] },
    { title: 'Cláusula 2 · Vigencia', lines: ['2.1 La cobertura rige durante el período indicado en las condiciones particulares.'] },
    { title: 'Cláusula 3 · Pago de la prima', lines: [
      '3.1 La prima se cobra una sola vez al emitir la póliza.',
      '3.2 El cobro queda registrado con un recibo y no genera cargos duplicados.'
    ] }
  ]
};

const weatherEvent: ProductConditions = {
  productName: 'Lluvia intensa',
  exclusions: [
    { code: '7.1', text: 'Precipitaciones inferiores al umbral de milímetros indicado en la cobertura.' },
    { code: '7.2', text: 'Mediciones de una estación distinta a la estación asegurada en la póliza.' },
    { code: '7.3', text: 'Lluvias ocurridas antes de la emisión o fuera de la vigencia.' },
    { code: '7.4', text: 'Mediciones que la fuente de datos meteorológicos no verifique.' }
  ],
  clauses: [
    { title: 'Cláusula 1 · Amparos', lines: ['1.1 Pago único cuando la precipitación verificada en 24 horas de la estación asegurada alcanza el umbral.'] },
    { title: 'Cláusula 2 · Vigencia', lines: ['2.1 La cobertura rige durante el período indicado en las condiciones particulares.'] },
    { title: 'Cláusula 3 · Pago de la prima', lines: [
      '3.1 La prima se cobra una sola vez al emitir la póliza.',
      '3.2 El cobro queda registrado con un recibo y no genera cargos duplicados.'
    ] }
  ]
};

export const CONDITIONS_VERSIONS: readonly ConditionsVersion[] = [
  { version: 'academic-conditions-1', since: '2026-01-01T00:00:00.000Z', products: { vida_hipotecario: mortgageLife, flight_delay: flightDelay, weather_event: weatherEvent } }
];

// The newest version already in force at the issue time; an earlier time falls back to the first version.
export function conditionsFor(product: AcceptedOffer['product'], issuedAt: string, versions: readonly ConditionsVersion[] = CONDITIONS_VERSIONS): ProductConditions & { version: string } {
  const inForce = versions.filter(item => Date.parse(item.since) <= Date.parse(issuedAt));
  const applied = inForce.length ? inForce.reduce((latest, item) => (Date.parse(item.since) > Date.parse(latest.since) ? item : latest)) : versions[0];
  return { version: applied.version, ...applied.products[product] };
}
