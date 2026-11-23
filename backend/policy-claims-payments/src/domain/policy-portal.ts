import { InvalidFinancialRecord } from './financial';
import type { AcceptedOffer, Coverage, FinancialResult } from './financial';
import { CONDITIONS_VERSIONS, conditionsFor } from './policy-conditions';
import type { ConditionsVersion, Exclusion } from './policy-conditions';

export const DOCUMENT_KINDS = ['signed_policy', 'general_conditions', 'premium_receipt'] as const;
export type PolicyDocumentKind = typeof DOCUMENT_KINDS[number];
export type PolicyDocumentEntry = { documentId: PolicyDocumentKind; issuedAt: string };
export type PolicyPaymentStatus = 'paid' | 'pending' | 'failed';
export type PolicyPaymentEntry = { date: string; amount: string; currency: 'COP'; status: PolicyPaymentStatus; reference: string | null };
export type PolicyDetail = { lifecycle?: import('./policy-lifecycle').LifecycleChange; policyId: string; product: AcceptedOffer['product']; status: 'issued'; premium: string; currency: 'COP';
  effectiveFrom: string; effectiveUntil: string; coverage: Coverage; exclusions: Exclusion[]; conditionsVersion: string;
  documents: PolicyDocumentEntry[]; payments: PolicyPaymentEntry[]; parametricPayment?: PolicyPaymentEntry };
export type DocumentFile = { fileName: string; title: string; lines: string[]; kicker?: string; meta?: string; signature?: { signedAt: string; fingerprint: string } };
type Failure = Extract<FinancialResult, { status: 'denied' | 'unavailable' }>;
export type PolicyDetailResult = { status: 'ok'; detail: PolicyDetail } | Failure;
export type PolicyDocumentResult = { status: 'ok'; file: DocumentFile } | Failure;
// Facts of an issued policy after the integrity checks; the premium date is the last change of its payment.
export type IssuedPolicyFacts = { lifecycle?: import('./policy-lifecycle').LifecycleChange; policyId: string; offer: AcceptedOffer; premium: string; currency: 'COP'; effectiveFrom: string; effectiveUntil: string;
  documentHash: string; signedAt: string;
  payment: { status: 'pending' | 'confirmed' | 'declined' | 'refunded'; reference: string | null; amount: string; at: string } };

const NOTICE = 'Documento sintético de demostración. No constituye una póliza, un pago real ni una cobertura legal.';

export const isDocumentKind = (value: string): value is PolicyDocumentKind => (DOCUMENT_KINDS as readonly string[]).includes(value);

// Colombia has no daylight saving time, so a fixed UTC-5 offset is exact.
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function colombiaTime(iso: string): string {
  const local = new Date(Date.parse(iso) - 5 * 3600000).toISOString();
  return `${Number(local.slice(8, 10))} de ${MONTHS[Number(local.slice(5, 7)) - 1]} de ${local.slice(0, 4)}, ${local.slice(11, 16)} (hora de Bogotá)`;
}
const PARAMETRIC_TITLE = 'Póliza de seguro paramétrico: ';

function pesos(amount: string): string {
  const [whole = '0', fraction = '0000'] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return '$ ' + grouped + (/^0*$/.test(fraction) ? '' : ',' + fraction.slice(0, 2));
}

function paymentStatus(status: IssuedPolicyFacts['payment']['status']): PolicyPaymentStatus {
  if (status === 'confirmed') return 'paid';
  if (status === 'pending') return 'pending';
  if (status === 'declined') return 'failed';
  throw new InvalidFinancialRecord();
}

function coverageLines(coverage: Coverage): string[] {
  if (coverage.kind === 'mortgage_life') return ['Amparo: fallecimiento del asegurado por cualquier causa.', 'Suma asegurada: ' + pesos(coverage.sumInsured)];
  if (coverage.kind === 'flight_delay') return ['Umbral de retraso: ' + coverage.thresholdMinutes + ' minutos', 'Pago por retraso: ' + pesos(coverage.payoutAmount), 'Vuelo asegurado: ' + coverage.flightReference];
  return ['Umbral de lluvia: ' + coverage.threshold + ' mm en 24 horas', 'Pago por lluvia intensa: ' + pesos(coverage.payoutAmount), 'Estación asegurada: ' + coverage.stationId];
}

export function policyDetail(facts: IssuedPolicyFacts, versions: readonly ConditionsVersion[] = CONDITIONS_VERSIONS): PolicyDetail {
  const conditions = conditionsFor(facts.offer.product, facts.signedAt, versions);
  const status = paymentStatus(facts.payment.status);
  const documents: PolicyDocumentEntry[] = [{ documentId: 'signed_policy', issuedAt: facts.signedAt }, { documentId: 'general_conditions', issuedAt: facts.signedAt }];
  if (status === 'paid') documents.push({ documentId: 'premium_receipt', issuedAt: facts.payment.at });
  return { ...(facts.lifecycle ? { lifecycle: facts.lifecycle } : {}), policyId: facts.policyId, product: facts.offer.product, status: 'issued', premium: facts.premium, currency: facts.currency,
    effectiveFrom: facts.effectiveFrom, effectiveUntil: facts.effectiveUntil, coverage: facts.offer.coverage,
    exclusions: conditions.exclusions, conditionsVersion: conditions.version, documents,
    payments: [{ date: facts.payment.at, amount: facts.payment.amount, currency: 'COP', status,
      reference: status === 'paid' ? facts.payment.reference : null }] };
}

export function documentFile(kind: PolicyDocumentKind, facts: IssuedPolicyFacts, versions: readonly ConditionsVersion[] = CONDITIONS_VERSIONS): DocumentFile | null {
  const conditions = conditionsFor(facts.offer.product, facts.signedAt, versions);
  const fileName = `${kind.replace(/_/g, '-')}-${facts.policyId.slice(0, 8)}.pdf`;
  const reference = 'POL-' + facts.policyId.slice(0, 8).toUpperCase();
  const issued = colombiaTime(facts.signedAt);
  if (kind === 'signed_policy') return { fileName, title: facts.offer.product === 'vida_hipotecario' ? 'Póliza de seguro de vida grupo deudores' : PARAMETRIC_TITLE + conditions.productName,
    kicker: 'Documento de póliza', meta: 'N.º ' + reference + '   ·   Expedida el ' + issued,
    signature: { signedAt: issued, fingerprint: facts.documentHash }, lines: [
    'Referencia de póliza: ' + reference, 'Producto: ' + conditions.productName, 'Tomador y asegurado: Titular de la póliza', 'Emitida: ' + issued,
    'Vigencia: ' + colombiaTime(facts.effectiveFrom) + ' hasta ' + colombiaTime(facts.effectiveUntil),
    'Prima: ' + pesos(facts.premium) + ' (pago único)', ...coverageLines(facts.offer.coverage),
    'Exclusiones: las señaladas en la cláusula 7 de las condiciones generales.',
    'Huella del documento firmado: ' + facts.documentHash, 'Identificador interno: ' + facts.policyId, '', NOTICE] };
  if (kind === 'general_conditions') return { fileName, title: 'Condiciones generales · ' + conditions.productName, kicker: 'Condiciones generales',
    meta: 'Póliza ' + reference + '   ·   Versión ' + conditions.version, lines: [
    'Versión de las condiciones: ' + conditions.version, '',
    ...conditions.clauses.flatMap(clause => [clause.title, ...clause.lines, '']),
    'Cláusula 7 · Exclusiones', ...conditions.exclusions.map(item => item.code + ' ' + item.text), '', NOTICE] };
  if (facts.payment.status !== 'confirmed') return null;
  return { fileName, title: 'Recibo de pago de la prima', kicker: 'Comprobante de pago', meta: 'Póliza ' + reference + '   ·   Pagado el ' + colombiaTime(facts.payment.at), lines: [
    'Referencia de póliza: ' + reference, 'Referencia del recibo: ' + (facts.payment.reference ?? 'sin referencia'),
    'Monto: ' + pesos(facts.payment.amount), 'Fecha: ' + colombiaTime(facts.payment.at), 'Estado: pagado', 'Identificador interno de la póliza: ' + facts.policyId, '', NOTICE] };
}
