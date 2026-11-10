import type { AcceptedOffer } from './financial';

// The wording is academic demonstration text, kept in es-CO because it is the contract language of the document.
// It is joined to a policy when it is read, so it is not part of the signed document or its hash.
export const CONDITIONS_VERSION = 'academic-conditions-1';
export type Exclusion = { code: string; text: string };
export type Clause = { title: string; lines: string[] };
export type ProductConditions = { productName: string; exclusions: Exclusion[]; clauses: Clause[] };

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

export function conditionsFor(product: AcceptedOffer['product']): ProductConditions {
  return product === 'flight_delay' ? flightDelay : mortgageLife;
}
