import type { RefObject } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import type { Policy } from './api';
import { DocumentFields } from './DocumentFields';
import { DocSection, DocSignature, DocTable, DocVerification, DocumentSheet } from './DocumentSheet';
import { policyNumber, signatureStroke } from './document-tools';

const MONEY = /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/;

function parsedDocument(policy: Policy): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(policy.document);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function sumInsured(document: Record<string, unknown>): string | null {
  const coverage = document.coverage;
  return coverage && typeof coverage === 'object' && 'sumInsured' in coverage && typeof coverage.sumInsured === 'string' && MONEY.test(coverage.sumInsured)
    ? coverage.sumInsured : null;
}

function usePolicyText() {
  const intl = useIntl();
  return (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
}

export function PolicyGeneralSections({ policy, holderName, statusText, fingerprint = false }: { policy: Policy; holderName?: string; statusText: string; fingerprint?: boolean }) {
  const t = usePolicyText();
  const { copDecimal, longDate } = useFormatters();
  const document = parsedDocument(policy);
  const insured = sumInsured(document);
  return <>
    <DocSection number={1} title={t('sheet.sectionGeneral')}>
      <DocTable rows={[
        { label: t('sheet.product'), value: t('policies.product.vida_hipotecario') },
        { label: t('policies.reference'), value: policyNumber(policy.policyId), mono: true },
        { label: t('sheet.holder'), value: holderName?.trim() || t('sheet.holderAccount') },
        { label: t('offer.period'), value: t('offer.periodValue', { from: longDate(new Date(policy.effectiveFrom)), until: longDate(new Date(policy.effectiveUntil)) }) },
        { label: t('sheet.status'), value: statusText },
        ...(fingerprint ? [{ label: t('policy.hash'), value: <span className="doc-hash">{policy.documentHash}</span>, mono: true }] : []),
      ]} />
    </DocSection>
    <DocSection number={2} title={t('sheet.sectionCoverage')}>
      <DocTable rows={[
        { label: t('offer.coverage'), value: t('offer.coverageValue') },
        { label: t('offer.sumInsured'), value: insured ? <span className="doc-amount">{copDecimal(insured)}</span> : '—' },
        { label: t('sheet.currency'), value: 'COP' },
      ]} />
    </DocSection>
  </>;
}

export function PolicyPremiumSection({ policy, number = 3 }: { policy: Policy; number?: number }) {
  const t = usePolicyText();
  const { copDecimal } = useFormatters();
  const paid = policy.payment?.status === 'confirmed';
  return <DocSection number={number} title={t('sheet.sectionPremium')}>
    <DocTable rows={[
      { label: t('issued.premium'), value: <span className="doc-amount">{copDecimal(policy.premium)}</span> },
      { label: t('sheet.paymentTerms'), value: t('sheet.coverageNote') },
      { label: t('sheet.paymentState'), value: t(paid ? 'sheet.paymentPaid' : 'sheet.paymentPending') },
      ...(paid && policy.payment?.reference ? [{ label: t('charge.receipt'), value: policy.payment.reference, mono: true }] : []),
    ]} />
  </DocSection>;
}

export function DraftPolicyPage({ policy, page, holderName, stage, headingRef }: {
  policy: Policy; page: 1 | 2; holderName?: string; stage: 'review' | 'sign'; headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const t = usePolicyText();
  const document = parsedDocument(policy);
  const version = String(document.offerVersion ?? 1);
  return <DocumentSheet kicker={t(stage === 'sign' ? 'sheet.kickerSign' : 'sheet.kickerDraft')} title={t('sheet.policyTitle')} number={policyNumber(policy.policyId)}
    meta={<span>{t('policy.version', { version })}</span>} status="draft" statusLabel={t(stage === 'sign' ? 'sheet.sealDraft' : 'policy.pendingIssuance')}
    watermark={t('sheet.watermarkDraft')} page={page} total={2} label={t('sheet.pageLabel', { current: String(page), total: '2' })}>
    {page === 1 ? <>
      <h2 ref={headingRef} tabIndex={-1} className="doc-page-heading">{t('policy.conditions')}</h2>
      <PolicyGeneralSections policy={policy} holderName={holderName} statusText={t(stage === 'sign' ? 'sheet.sealDraft' : 'policy.pendingIssuance')} fingerprint />
      <PolicyPremiumSection policy={policy} />
    </> : <>
      <h2 ref={headingRef} tabIndex={-1} className="doc-page-heading">{t('policy.document')}</h2>
      <DocSection number={4} title={t('sheet.sectionContent')}>
        <p className="doc-section-intro">{t('sheet.contentIntro')}</p>
        <div className="doc-annex"><DocumentFields document={document} /></div>
      </DocSection>
      <DocSection number={5} title={t('sheet.sectionSignature')}>
        <DocSignature signed={false} name={holderName?.trim() || t('sheet.holderAccount')} role={t('sheet.holderRole')} method={t('sheet.signatureMethodValue')} stroke="" />
      </DocSection>
      <DocSection number={6} title={t('sheet.sectionVerification')}>
        <DocVerification hash={policy.documentHash} rows={[{ label: t('policies.reference'), value: policyNumber(policy.policyId), mono: true }]} note={t('sheet.verificationDraftNote')} />
      </DocSection>
    </>}
  </DocumentSheet>;
}

export function IssuedPolicyPage({ policy, holderName, signedAt }: { policy: Policy; holderName?: string; signedAt: string | null }) {
  const t = usePolicyText();
  const name = holderName?.trim() || t('sheet.holderAccount');
  return <DocumentSheet kicker={t('sheet.kicker')} title={t('sheet.policyTitle')} number={policyNumber(policy.policyId)}
    meta={signedAt ? <span>{t('sheet.issuedOn', { date: signedAt })}</span> : undefined} status="signed" statusLabel={t('sheet.sealIssued')} page={1} total={1}>
    <PolicyGeneralSections policy={policy} holderName={holderName} statusText={t('sheet.statusIssued')} />
    <PolicyPremiumSection policy={policy} />
    <DocSection number={4} title={t('sheet.sectionSignature')}>
      <DocSignature signed name={name} role={t('sheet.holderRole')} signedAt={signedAt} method={t('sheet.signatureMethodValue')}
        reference={`SHA-256 ${policy.documentHash.slice(0, 16)}…`} stroke={signatureStroke(policy.documentHash)} />
    </DocSection>
    <DocSection number={5} title={t('sheet.sectionVerification')}>
      <DocVerification hash={policy.documentHash} rows={[{ label: t('policies.reference'), value: policyNumber(policy.policyId), mono: true }]} support={[
        { label: t('sheet.internalId'), value: policy.policyId, mono: true },
        { label: t('issued.reference'), value: policy.traceId, mono: true },
      ]} note={t('issued.onceDetail')} />
    </DocSection>
  </DocumentSheet>;
}

export function ReceiptPage({ policy }: { policy: Policy }) {
  const t = usePolicyText();
  const { copDecimal } = useFormatters();
  return <DocumentSheet kicker={t('sheet.kickerReceipt')} title={t('sheet.receiptTitle')} meta={<span>{t('sheet.receiptFor', { number: policyNumber(policy.policyId) })}</span>} status="paid"
    statusLabel={t('sheet.paymentPaid')} page={1} total={1}>
    <DocSection number={1} title={t('sheet.sectionPayment')}>
      <DocTable rows={[
        { label: t('sheet.concept'), value: t('sheet.conceptValue') },
        { label: t('sheet.product'), value: t('policies.product.vida_hipotecario') },
        { label: t('charge.charged'), value: <span className="doc-amount">{copDecimal(policy.premium)}</span> },
        { label: t('sheet.paymentMethod'), value: t('sheet.paymentMethodValue') },
        { label: t('charge.receipt'), value: policy.payment?.reference ?? '—', mono: true },
        { label: t('sheet.paymentState'), value: t('sheet.paymentPaid') },
      ]} />
    </DocSection>
  </DocumentSheet>;
}
