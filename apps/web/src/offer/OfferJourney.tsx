import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { useAnnounce } from '../quote/Live';
import { Stepper } from '../quote/Stepper';
import type { Quote } from '../quote/api';
import { financialApi, newIdempotencyKey, type Acceptance, type FinancialApi, type FinancialOutcome, type Offer, type Policy } from './api';
import { OfferCard, PolicyDocument, PolicyIssued } from './OfferViews';

type Step = 4 | 5 | 6;
type Phase =
  | { name: 'creating' }
  | { name: 'offer'; offer: Offer; accepting: boolean }
  | { name: 'declined' }
  | { name: 'expired'; offerId?: string }
  | { name: 'preparing'; acceptance: Acceptance; slow: boolean }
  | { name: 'review'; policy: Policy; confirming: boolean; problem?: 'uncertain' | 'document_changed' }
  | { name: 'issued'; policy: Policy }
  | { name: 'recovering'; policy: Policy; busy: boolean }
  | { name: 'refunded'; policy: Policy }
  | { name: 'failed'; reason: 'payment' | 'conflict' | 'generic'; step: Step }
  | { name: 'unavailable'; retry: () => void; traceId?: string; step: Step };

export type PollSchedule = { firstDelayMs: number; maxDelayMs: number; budgetMs: number };
// Accepted-offer delivery is asynchronous (outbox, Queue, Policy inbox); the read is retried within a bounded budget.
const DEFAULT_POLL: PollSchedule = { firstDelayMs: 400, maxDelayMs: 3000, budgetMs: 60000 };

function stepOf(phase: Phase): number {
  if (phase.name === 'failed' || phase.name === 'unavailable') return phase.step;
  return phase.name === 'preparing' || phase.name === 'review' ? 5 : phase.name === 'issued' ? 7 : phase.name === 'recovering' || phase.name === 'refunded' ? 6 : 4;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function OfferJourney(props: {
  quote: Quote;
  api?: FinancialApi;
  poll?: PollSchedule;
  onRequote: () => void;
  onConsentRequired: () => void;
  onBack: () => void;
  onSessionLost?: () => void;
}) {
  const { quote, onRequote, onBack } = props;
  const intl = useIntl();
  const { copDecimal } = useFormatters();
  const announce = useAnnounce();
  const [phase, setPhase] = useState<Phase>({ name: 'creating' });
  const [checked, setChecked] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // Requests read the latest language, callbacks and API, so a re-render or locale change never restarts the journey.
  const latest = useRef({ props, intl, announce, copDecimal });
  latest.current = { props, intl, announce, copDecimal };
  const signal = useRef<AbortSignal | null>(null);
  // One key per command and resource: repeated clicks, retries and lost responses replay the same server operation.
  const createKey = useRef(newIdempotencyKey());
  const acceptKeys = useRef(new Map<string, string>());
  const issueKeys = useRef(new Map<string, string>());
  const accepted = useRef<Acceptance | null>(null);
  const knownPolicyId = useRef<string | null>(null);
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const say = (id: string, values?: Record<string, string>) => latest.current.announce(latest.current.intl.formatMessage({ id }, values));
  const api = () => latest.current.props.api ?? financialApi;

  useEffect(() => { heading.current?.focus(); }, [phase.name]);

  // Shared handling for responses that end a step the same way everywhere. Returns true when it changed the screen.
  function common(outcome: FinancialOutcome<unknown>, retry: () => void, step: Step): boolean {
    if (outcome.kind === 'unauthenticated') { say('live.sessionExpired'); latest.current.props.onSessionLost?.(); return true; }
    if (outcome.kind === 'consentRequired') { say('live.offerConsentRequired'); latest.current.props.onConsentRequired(); return true; }
    if (outcome.kind === 'unavailable') { setPhase({ name: 'unavailable', retry, traceId: outcome.traceId, step }); say('live.financialUnavailable'); return true; }
    return false;
  }
  function fail(reason: 'payment' | 'conflict' | 'generic', step: Step) {
    setPhase({ name: 'failed', reason, step }); say('live.financialError');
  }
  function expired(offerId?: string) {
    setPhase({ name: 'expired', offerId }); say('live.offerExpired');
  }

  async function create(current: AbortSignal) {
    setPhase({ name: 'creating' });
    try {
      const outcome = await api().createOffer(quote.quoteId, createKey.current, current);
      if (current.aborted || common(outcome, () => void create(current), 4)) return;
      if (outcome.kind === 'ok') {
        setPhase({ name: 'offer', offer: outcome.value, accepting: false });
        say('live.offerReady', { premium: latest.current.copDecimal(outcome.value.premium) });
      } else if (outcome.kind === 'rejected' && outcome.code === 'declined') { setPhase({ name: 'declined' }); say('live.offerDeclined'); }
      else if (outcome.kind === 'rejected' && outcome.code === 'expired') expired();
      else fail('generic', 4);
    } catch { /* aborted: the user left the screen */ }
  }

  // Each mount owns its controller, so StrictMode's effect replay never reuses an aborted signal.
  // The offer is requested once per mounted quote; later values are read through `latest`.
  const start = useRef(create);
  start.current = create;
  useEffect(() => {
    const controller = new AbortController();
    signal.current = controller.signal;
    void start.current(controller.signal);
    return () => controller.abort();
  }, []);

  async function waitForPolicy(acceptance: Acceptance, documentChanged = false) {
    const current = signal.current;
    if (!current || current.aborted) return;
    accepted.current = acceptance;
    setPhase({ name: 'preparing', acceptance, slow: false });
    const { firstDelayMs, maxDelayMs, budgetMs } = latest.current.props.poll ?? DEFAULT_POLL;
    const started = Date.now();
    let delay = firstDelayMs;
    try {
      for (;;) {
        const outcome = await api().policyForAcceptance(acceptance, current);
        if (current.aborted) return;
        if (outcome.kind === 'ok') {
          if (knownPolicyId.current && knownPolicyId.current !== outcome.value.policyId) { fail('generic', 5); return; }
          knownPolicyId.current = outcome.value.policyId;
          setChecked(false);
          if (outcome.value.status === 'issued') { setPhase({ name: 'issued', policy: outcome.value }); say('live.issued'); }
          else if (outcome.value.status === 'refunded') { setPhase({ name: 'refunded', policy: outcome.value }); say('live.refunded'); }
          else if (outcome.value.status === 'refunding') { setPhase({ name: 'recovering', policy: outcome.value, busy: false }); say('live.refunding'); }
          else { setPhase({ name: 'review', policy: outcome.value, confirming: false, ...(documentChanged ? { problem: 'document_changed' as const } : {}) }); say('live.policyReady'); }
          return;
        }
        if (outcome.kind === 'unauthenticated' || outcome.kind === 'consentRequired') { common(outcome, () => {}, 5); return; }
        // 404 means the signed acceptance has not been imported yet; a transient outage is retried within the same budget.
        if (outcome.kind !== 'notFound' && outcome.kind !== 'unavailable') { fail('generic', 5); return; }
        if (Date.now() - started >= budgetMs) { setPhase({ name: 'preparing', acceptance, slow: true }); say('live.policySlow'); return; }
        await pause(delay, current);
        delay = Math.min(Math.ceil(delay * 1.5), maxDelayMs);
      }
    } catch { /* aborted: the user left the screen */ }
  }

  async function accept(offer: Offer) {
    const current = signal.current;
    if (!current || phase.name !== 'offer' || phase.accepting) return;
    const key = acceptKeys.current.get(offer.offerId) ?? newIdempotencyKey();
    acceptKeys.current.set(offer.offerId, key);
    setPhase({ name: 'offer', offer, accepting: true });
    try {
      const outcome = await api().acceptOffer(offer.offerId, key, current);
      if (current.aborted || common(outcome, () => setPhase({ name: 'offer', offer, accepting: false }), 4)) return;
      if (outcome.kind === 'ok') { say('live.accepted'); void waitForPolicy(outcome.value); }
      else if (outcome.kind === 'rejected' && outcome.code === 'expired') expired(offer.offerId);
      else fail(outcome.kind === 'rejected' && outcome.code === 'conflict' ? 'conflict' : 'generic', 4);
    } catch { /* aborted: the user left the screen */ }
  }

  async function issue(policy: Policy) {
    const current = signal.current;
    const recovering = phase.name === 'recovering' && !phase.busy;
    if (!current || (!recovering && (phase.name !== 'review' || phase.confirming || !checked))) return;
    const identity = `${policy.policyId}:${policy.documentHash}`;
    const key = issueKeys.current.get(identity) ?? newIdempotencyKey();
    issueKeys.current.set(identity, key);
    setPhase(recovering ? { name: 'recovering', policy, busy: true } : { name: 'review', policy, confirming: true });
    try {
      const outcome = await api().issuePolicy(policy, key, current);
      if (current.aborted) return;
      if (outcome.kind === 'unauthenticated' || outcome.kind === 'consentRequired') { common(outcome, () => {}, 6); return; }
      if (outcome.kind === 'ok' && outcome.value.status === 'issued' && outcome.value.documentHash === policy.documentHash) {
        setPhase({ name: 'issued', policy: outcome.value }); say('live.issued');
        return;
      }
      if (outcome.kind === 'ok' || outcome.kind === 'unavailable') {
        // The charge or signature may have committed without a confirmation reaching us: retry only with the same key.
        setPhase(recovering ? { name: 'recovering', policy, busy: false } : { name: 'review', policy, confirming: false, problem: 'uncertain' }); say(recovering ? 'live.refunding' : 'live.issueUncertain');
        return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'offer_invalid') { expired(policy.offerId); return; }
      if (outcome.kind === 'rejected' && outcome.code === 'document_mismatch') {
        setChecked(false);
        if (accepted.current) await waitForPolicy(accepted.current, true); else fail('generic', 6);
        return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'signature_failed') {
        // This code can mean either refunding or refunded. Read durable state before claiming compensation.
        if (accepted.current) await waitForPolicy(accepted.current); else fail('generic', 6);
        return;
      }
      fail(outcome.kind === 'rejected' && outcome.code === 'payment_declined' ? 'payment' : 'generic', 6);
    } catch { /* aborted: the user left the screen */ }
  }

  return <>
    <Stepper current={stepOf(phase)} available={7} />
    {phase.name === 'creating' && <section className="step card" aria-busy="true">
      <h1 ref={heading} tabIndex={-1} className="h-card">{t('offer.loading')}</h1>
      <p>{t('offer.loadingDetail')}</p>
    </section>}
    {phase.name === 'offer' && <OfferCard heading={heading} offer={phase.offer} accepting={phase.accepting} onAccept={() => void accept(phase.offer)} onBack={onBack} />}
    {phase.name === 'declined' && <section className="step card declined-card">
      <header className="consent-head"><h1 ref={heading} tabIndex={-1} className="h-card">{t('offer.declinedTitle')}</h1></header>
      <div className="declined-body">
        <p>{t('offer.declinedDetail')}</p>
        <div className="actions"><button type="button" className="btn btn-secondary" onClick={onBack}>{t('offer.backToEstimate')}</button></div>
      </div>
    </section>}
    {phase.name === 'expired' && <section className="step card card-warning">
      <div className="warning-head">
        <span aria-hidden="true" className="warning-icon">!</span>
        <h1 ref={heading} tabIndex={-1} className="h-card">{phase.offerId ? t('offer.expiredTitleId', { id: phase.offerId }) : t('offer.expiredTitle')}</h1>
      </div>
      <div className="denied-body">
        <p>{t('offer.expiredDetail')}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onRequote}>{t('offer.requote')}</button>
          <button type="button" className="btn btn-secondary" onClick={onBack}>{t('offer.backToEstimate')}</button>
        </div>
      </div>
    </section>}
    {phase.name === 'preparing' && <section className="step card" aria-busy={!phase.slow}>
      <div className="result-head">
        <div>
          <h1 ref={heading} tabIndex={-1} className="h-card">{t('policy.preparingTitle')}</h1>
          <p className="mono">{t('policy.acceptance')} {phase.acceptance.acceptanceId}</p>
        </div>
        <span className="pill pill-pending">{t('policy.pendingIssuance')}</span>
      </div>
      <p>{t(phase.slow ? 'policy.slowDetail' : 'policy.preparingDetail')}</p>
      {phase.slow && <div className="actions"><button type="button" className="btn btn-primary" onClick={() => void waitForPolicy(phase.acceptance)}>{t('policy.refresh')}</button></div>}
    </section>}
    {phase.name === 'review' && <PolicyDocument heading={heading} policy={phase.policy} checked={checked} confirming={phase.confirming} problem={phase.problem}
      onCheck={setChecked} onConfirm={() => void issue(phase.policy)} />}
    {phase.name === 'issued' && <PolicyIssued heading={heading} policy={phase.policy} />}
    {(phase.name === 'recovering' || phase.name === 'refunded') && <section className="step card" aria-busy={phase.name === 'recovering' && phase.busy}>
      <h1 ref={heading} tabIndex={-1} className="h-card">{t(phase.name === 'refunded' ? 'policy.refundedTitle' : 'policy.refundingTitle')}</h1>
      <p>{t(phase.name === 'refunded' ? 'policy.refundedDetail' : 'policy.refundingDetail')}</p>
      <p className="trace mono">{t('issued.policy')}: {phase.policy.policyId}<br />{t('issued.reference')}: {phase.policy.traceId}</p>
      <div className="actions">
        {phase.name === 'recovering'
          ? <button type="button" className="btn btn-primary" disabled={phase.busy} onClick={() => void issue(phase.policy)}>{t('policy.recover')}</button>
          : <button type="button" className="btn btn-primary" onClick={onRequote}>{t('offer.requote')}</button>}
      </div>
    </section>}
    {phase.name === 'failed' && <section className="step card card-error">
      <div className="denied-head">
        <span aria-hidden="true" className="denied-icon">×</span>
        <h1 ref={heading} tabIndex={-1} className="h-card">{t('policy.failedTitle')}</h1>
      </div>
      <div className="denied-body">
        <p>{t(`policy.failed.${phase.reason}`)}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onRequote}>{t('offer.requote')}</button>
          <button type="button" className="btn btn-secondary" onClick={onBack}>{t('offer.backToEstimate')}</button>
        </div>
      </div>
    </section>}
    {phase.name === 'unavailable' && <section className="step">
      <h1 ref={heading} tabIndex={-1} className="h-card">{t('financial.unavailableTitle')}</h1>
      <div className="banner banner-error"><span aria-hidden="true" className="banner-icon">!</span><p>{t('financial.unavailable')}</p></div>
      {phase.traceId && <p className="trace mono">{t('denied.trace')}: {phase.traceId}</p>}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={phase.retry}>{t('financial.retry')}</button>
        <button type="button" className="btn btn-secondary" onClick={onBack}>{t('offer.backToEstimate')}</button>
      </div>
    </section>}
  </>;
}
