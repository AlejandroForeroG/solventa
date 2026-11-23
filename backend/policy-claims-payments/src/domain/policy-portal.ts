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
export type DocumentFile = { fileName: string; title: string; lines: string[]; kicker?: string; meta?: string; stamp?: string; footer?: string;
  signature?: { section: string; title: string; before: string; signedAt: string; fingerprint: string } };
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
function colombiaDate(iso: string): string {
  const local = new Date(Date.parse(iso) - 5 * 3600000).toISOString();
  return `${Number(local.slice(8, 10))} de ${MONTHS[Number(local.slice(5, 7)) - 1]} de ${local.slice(0, 4)}`;
}
function colombiaTime(iso: string): string {
  const local = new Date(Date.parse(iso) - 5 * 3600000).toISOString();
  const hour = Number(local.slice(11, 13));
  return `${colombiaDate(iso)}, ${String(hour % 12 || 12).padStart(2, '0')}:${local.slice(14, 16)} ${hour < 12 ? 'a. m.' : 'p. m.'} (hora de Bogotá)`;
}
const PAYMENT_LABEL: Record<PolicyPaymentStatus, string> = { paid: 'Pagado', pending: 'Pendiente', failed: 'Fallido' };
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
  const product = facts.offer.product === 'vida_hipotecario' ? 'Seguro de vida hipotecario' : conditions.productName;
  const issued = colombiaTime(facts.signedAt);
  const paid = colombiaTime(facts.payment.at);
  const verification = 'Sección 6 · Verificación del documento';
  if (kind === 'signed_policy') return { fileName, title: facts.offer.product === 'vida_hipotecario' ? 'Póliza de seguro de vida grupo deudores' : PARAMETRIC_TITLE + conditions.productName,
    kicker: 'Documento de póliza', meta: 'N.º ' + reference + '  ·  Expedida el ' + issued, stamp: 'Emitida', footer: reference,
    signature: { section: '5', title: 'Firma del tomador', before: verification, signedAt: issued, fingerprint: facts.documentHash }, lines: [
    'Sección 1 · Datos de la póliza', 'Producto: ' + product, 'Referencia de póliza: ' + reference, 'Tomador y asegurado: Titular de la póliza',
    'Vigencia: ' + colombiaDate(facts.effectiveFrom) + ' – ' + colombiaDate(facts.effectiveUntil), 'Emitida: ' + issued, 'Estado: Emitida y firmada electrónicamente',
    'Sección 2 · Cobertura y valor asegurado', ...coverageLines(facts.offer.coverage), 'Moneda: COP',
    'Sección 3 · Prima y forma de pago', 'Prima: ' + pesos(facts.premium) + ' (pago único)', 'Forma de pago: Pago único por toda la vigencia.',
    'Estado del pago: ' + PAYMENT_LABEL[paymentStatus(facts.payment.status)], 'Recibo: ' + (facts.payment.reference ?? 'Sin referencia'),
    'Sección 4 · Exclusiones', 'Las señaladas en la cláusula 7 de las condiciones generales de la póliza.',
    verification, 'Huella SHA-256: ' + facts.documentHash, 'Referencia de póliza: ' + reference, 'Identificador interno: ' + facts.policyId] };
  const clauses = [...conditions.clauses.map(clause => /\d+/.exec(clause.title)?.[0]).filter(Boolean), '7'];
  if (kind === 'general_conditions') return { fileName, title: product, kicker: 'Condiciones generales',
    meta: 'Póliza ' + reference + '  ·  Versión ' + conditions.version, footer: reference, lines: [
    'Versión de las condiciones: ' + conditions.version, 'Producto: ' + product,
    'Alcance: extracto con las cláusulas ' + clauses.slice(0, -1).join(', ') + ' y ' + clauses[clauses.length - 1] + ' aplicables a esta póliza.', '',
    ...conditions.clauses.flatMap(clause => [clause.title, ...clause.lines, '']),
    'Cláusula 7 · Exclusiones', ...conditions.exclusions.map(item => item.code + ' ' + item.text), '', NOTICE] };
  if (facts.payment.status !== 'confirmed') return null;
  return { fileName, title: 'Comprobante de pago de la prima', kicker: 'Comprobante de pago', meta: 'Póliza ' + reference + '  ·  Pagado el ' + paid, stamp: 'Pagado', footer: reference, lines: [
    'Sección 1 · Detalle del pago', 'Concepto: Prima única de la póliza', 'Producto: ' + product, 'Monto: ' + pesos(facts.payment.amount),
    'Medio de pago: Cobro simulado, sin movimiento de dinero real', 'Referencia del recibo: ' + (facts.payment.reference ?? 'sin referencia'),
    'Fecha: ' + paid, 'Estado: pagado',
    'Sección 2 · Verificación', 'Referencia de póliza: ' + reference, 'Huella SHA-256: ' + facts.documentHash, 'Identificador interno: ' + facts.policyId, '', NOTICE] };
}
