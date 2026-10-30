import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { useAnnounce } from '../quote/Live';
import { Stepper } from '../quote/Stepper';
import type { Quote } from '../quote/api';
import { financialApi, newIdempotencyKey, type Acceptance, type FinancialApi, type FinancialOutcome, type Offer, type Policy, type SignatureChallenge } from './api';
import { ChargeConfirmed, ChargeDeclined, ChargePending, OfferCard, PolicyDocument, PolicyIssued } from './OfferViews';
import { clearPurchaseDraft, savePurchaseDraft, type PurchaseDraft } from './purchase-draft';

type Step = 4 | 5 | 6 | 7;
type Phase =
  | { name: 'creating' }
  | { name: 'offer'; offer: Offer; accepting: boolean }
  | { name: 'declined' }
  | { name: 'expired'; offerId?: string }
  | { name: 'preparing'; acceptance: Acceptance; slow: boolean }
  | { name: 'review'; policy: Policy; documentChanged: boolean }
  | { name: 'awaitingPayment'; policy: Policy }
  | { name: 'charging'; policy: Policy; busy: boolean; uncertain: boolean; key: string }
  | { name: 'charged'; policy: Policy }
  | { name: 'signing'; policy: Policy; busy: boolean; uncertain: boolean }
  | { name: 'chargeDeclined'; policy: Policy }
  | { name: 'issued'; policy: Policy }
  | { name: 'recovering'; policy: Policy; busy: boolean }
  | { name: 'refunded'; policy: Policy }
  | { name: 'failed'; reason: 'conflict' | 'generic'; step: Step }
  | { name: 'unavailable'; retry: () => void; traceId?: string; step: Step };

export type PollSchedule = { firstDelayMs: number; maxDelayMs: number; budgetMs: number };
// Accepted-offer delivery is asynchronous (outbox, Queue, Policy inbox); the read is retried within a bounded budget.
const DEFAULT_POLL: PollSchedule = { firstDelayMs: 50, maxDelayMs: 100, budgetMs: 60000 };

function stepOf(phase: Phase): number {
  if (phase.name === 'failed' || phase.name === 'unavailable') return phase.step;
  if (phase.name === 'preparing' || phase.name === 'review') return 5;
  if (['awaitingPayment', 'charging', 'charged', 'chargeDeclined'].includes(phase.name)) return 6;
  if (['signing', 'issued', 'recovering', 'refunded'].includes(phase.name)) return 7;
  return 4;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Phases after which a reload has nothing left to resume.
const SETTLED: readonly Phase['name'][] = ['declined', 'expired', 'chargeDeclined', 'issued', 'refunded', 'failed'];

export function OfferJourney(props: {
  quote: Pick<Quote, 'quoteId'>;
  resume?: PurchaseDraft;
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
  const [challenge, setChallenge] = useState<SignatureChallenge | null>(null);
  const [code, setCode] = useState('');
  const [challengeBusy, setChallengeBusy] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Requests read the latest language, callbacks and API, so a re-render or locale change never restarts the journey.
  const latest = useRef({ props, intl, announce, copDecimal });
  latest.current = { props, intl, announce, copDecimal };
  const signal = useRef<AbortSignal | null>(null);
  // One key per command and resource: repeated clicks, retries and lost responses replay the same server operation.
  const createKey = useRef(newIdempotencyKey());
  const acceptKeys = useRef(new Map<string, string>());
  const issueKeys = useRef(new Map<string, string>());
  const chargeKeys = useRef(new Map<string, string>());
  const issueChallengeId = useRef<string | null>(props.resume?.issue?.challengeId ?? null);
  const accepted = useRef<Acceptance | null>(null);
  const knownPolicyId = useRef<string | null>(null);
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const say = (id: string, values?: Record<string, string>) => latest.current.announce(latest.current.intl.formatMessage({ id }, values));
  const api = () => latest.current.props.api ?? financialApi;

  useEffect(() => {
    heading.current?.focus();
    if (SETTLED.includes(phase.name)) clearPurchaseDraft();
  }, [phase.name]);

  // Shared handling for responses that end a step the same way everywhere. Returns true when it changed the screen.
  function common(outcome: FinancialOutcome<unknown>, retry: () => void, step: Step): boolean {
    if (outcome.kind === 'unauthenticated') { say('live.sessionExpired'); latest.current.props.onSessionLost?.(); return true; }
    if (outcome.kind === 'consentRequired') { say('live.offerConsentRequired'); latest.current.props.onConsentRequired(); return true; }
    if (outcome.kind === 'unavailable') { setPhase({ name: 'unavailable', retry, traceId: outcome.traceId, step }); say('live.financialUnavailable'); return true; }
    return false;
  }
  function fail(reason: 'conflict' | 'generic', step: Step) {
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
  // After a reload the journey resumes from the stored acceptance and command key instead of creating another offer.
  const start = useRef((current: AbortSignal) => {
    const resume = latest.current.props.resume;
    if (!resume) return create(current);
    if (resume.issue) issueKeys.current.set(`${resume.issue.policyId}:${resume.issue.documentHash}`, resume.issue.key);
    if (resume.charge) chargeKeys.current.set(`${resume.charge.policyId}:${resume.charge.documentHash}`, resume.charge.key);
    return waitForPolicy(resume.acceptance);
  });
  useEffect(() => {
    const controller = new AbortController();
    signal.current = controller.signal;
    void start.current(controller.signal);
    return () => controller.abort();
  }, []);

  async function waitForPolicy(acceptance: Acceptance, documentChanged = false, paymentAwaited = false) {
    const current = signal.current;
    if (!current || current.aborted) return;
    accepted.current = acceptance;
    setPhase({ name: 'preparing', acceptance, slow: false });
    const { firstDelayMs, maxDelayMs, budgetMs } = latest.current.props.poll ?? DEFAULT_POLL;
    const started = Date.now();
    let delay = firstDelayMs;
    let outageDelay = 400;
    try {
      for (;;) {
        if (Date.now() - started >= budgetMs) { setPhase({ name: 'preparing', acceptance, slow: true }); say('live.policySlow'); return; }
        const outcome = await api().policyForAcceptance(acceptance, current);
        if (current.aborted) return;
        if (outcome.kind === 'ok') {
          if (knownPolicyId.current && knownPolicyId.current !== outcome.value.policyId) { fail('generic', 5); return; }
          knownPolicyId.current = outcome.value.policyId;
          const sentKey = issueKeys.current.get(`${outcome.value.policyId}:${outcome.value.documentHash}`);
          setChecked(false);
          if (outcome.value.status === 'issued') { setPhase({ name: 'issued', policy: outcome.value }); say('live.issued'); }
          else if (outcome.value.payment?.status === 'declined') { setPhase({ name: 'chargeDeclined', policy: outcome.value }); say('live.chargeDeclined'); }
          else if (outcome.value.status === 'refunded') { setPhase({ name: 'refunded', policy: outcome.value }); say('live.refunded'); }
          else if (outcome.value.status === 'refunding') { setPhase({ name: 'recovering', policy: outcome.value, busy: false }); say('live.refunding'); }
          else if (documentChanged && outcome.value.status === 'charged') {
            setChallenge(null); setCode(''); issueChallengeId.current = null;
            setPhase({ name: 'review', policy: outcome.value, documentChanged: true });
          }
          else if (outcome.value.status === 'charged' && outcome.value.payment?.status === 'confirmed') {
            setPhase(sentKey ? { name: 'signing', policy: outcome.value, busy: false, uncertain: true }
              : { name: 'charged', policy: outcome.value });
          }
          else if (outcome.value.payment?.status === 'pending' && chargeKeys.current.has(`${outcome.value.policyId}:${outcome.value.documentHash}`)) {
            setPhase({ name: 'charging', policy: outcome.value, busy: false, uncertain: true,
              key: chargeKeys.current.get(`${outcome.value.policyId}:${outcome.value.documentHash}`)! });
          }
          else { setChallenge(null); setCode(''); issueChallengeId.current = null;
            setPhase(paymentAwaited ? { name: 'awaitingPayment', policy: outcome.value }
              : { name: 'review', policy: outcome.value, documentChanged });
            if (!paymentAwaited) say('live.policyReady'); }
          return;
        }
        if (outcome.kind === 'unauthenticated' || outcome.kind === 'consentRequired') { common(outcome, () => {}, 5); return; }
        // 404 means the signed acceptance has not been imported yet; a transient outage is retried within the same budget.
        if (outcome.kind !== 'notFound' && outcome.kind !== 'unavailable') { fail('generic', 5); return; }
        const elapsed = Date.now() - started;
        if (elapsed >= budgetMs) { setPhase({ name: 'preparing', acceptance, slow: true }); say('live.policySlow'); return; }
        // A brief pending import needs quick discovery; outages and sustained delay need less load, not faster polling.
        const waiting = outcome.kind === 'unavailable' ? outageDelay : elapsed < 3000 ? delay : Math.max(1000, delay);
        await pause(Math.min(waiting, budgetMs - elapsed), current);
        if (outcome.kind === 'unavailable') outageDelay = Math.min(Math.ceil(outageDelay * 1.5), 3000);
        else delay = Math.min(Math.ceil(waiting * 1.5), elapsed < 3000 ? maxDelayMs : 3000);
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
      if (outcome.kind === 'ok') {
        savePurchaseDraft({ quoteId: quote.quoteId, acceptance: outcome.value, issue: null });
        say('live.accepted'); void waitForPolicy(outcome.value);
      }
      else if (outcome.kind === 'rejected' && outcome.code === 'expired') expired(offer.offerId);
      else fail(outcome.kind === 'rejected' && outcome.code === 'conflict' ? 'conflict' : 'generic', 4);
    } catch { /* aborted: the user left the screen */ }
  }

  async function issue(policy: Policy) {
    const current = signal.current;
    const recovering = phase.name === 'recovering' && !phase.busy;
    const retrying = phase.name === 'signing' && !phase.busy && phase.uncertain;
    if (!current || (!recovering && !retrying && (phase.name !== 'signing' || phase.busy || !checked || !challenge || !/^[0-9]{6}$/.test(code)))) return;
    const activeChallengeId = challenge?.challengeId ?? issueChallengeId.current;
    if (!activeChallengeId) return;
    const identity = `${policy.policyId}:${policy.documentHash}`;
    const key = issueKeys.current.get(identity) ?? newIdempotencyKey();
    issueKeys.current.set(identity, key);
    if (accepted.current) savePurchaseDraft({ quoteId: quote.quoteId, acceptance: accepted.current,
      issue: { policyId: policy.policyId, documentHash: policy.documentHash, key, challengeId: activeChallengeId },
      charge: { policyId: policy.policyId, documentHash: policy.documentHash, key: chargeKeys.current.get(identity) ?? newIdempotencyKey() } });
    setPhase(recovering ? { name: 'recovering', policy, busy: true } : { name: 'signing', policy, busy: true, uncertain: retrying });
    try {
      const outcome = await api().issuePolicy(policy, key, activeChallengeId, challenge ? code : '000000', current);
      if (current.aborted) return;
      if (outcome.kind === 'unauthenticated' || outcome.kind === 'consentRequired') { common(outcome, () => {}, 7); return; }
      if (outcome.kind === 'ok' && outcome.value.status === 'issued' && outcome.value.documentHash === policy.documentHash
        && outcome.value.payment?.status === 'confirmed') {
        setPhase({ name: 'issued', policy: outcome.value });
        say('live.issued');
        return;
      }
      if (outcome.kind === 'ok' || outcome.kind === 'unavailable') {
        // The signature may have committed without a confirmation reaching us: retry with the same key.
        setPhase(recovering ? { name: 'recovering', policy, busy: false } : { name: 'signing', policy, busy: false, uncertain: true }); say(recovering ? 'live.refunding' : 'live.issueUncertain');
        return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'offer_invalid') { expired(policy.offerId); return; }
      if (outcome.kind === 'rejected' && outcome.code === 'document_mismatch') {
        setChecked(false);
        setChallenge(null);
        if (accepted.current) await waitForPolicy(accepted.current, true); else fail('generic', 7);
        return;
      }
      if (outcome.kind === 'rejected' && ['authentication_failed', 'challenge_invalid', 'challenge_expired', 'challenge_cancelled'].includes(outcome.code)) {
        setPhase({ name: 'signing', policy, busy: false, uncertain: false });
        setChallengeError(outcome.code);
        if (outcome.code !== 'authentication_failed') { setChallenge(null); setCode(''); setChecked(false); }
        return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'signature_failed') {
        // This code can mean either refunding or refunded. Read durable state before claiming compensation.
        if (accepted.current) await waitForPolicy(accepted.current); else fail('generic', 7);
        return;
      }
      fail('generic', 7);
    } catch { /* aborted: the user left the screen */ }
  }

  async function charge(policy: Policy) {
    const current = signal.current;
    if (!current || (phase.name === 'charging' && phase.busy)) return;
    const identity = `${policy.policyId}:${policy.documentHash}`;
    const key = chargeKeys.current.get(identity) ?? newIdempotencyKey();
    chargeKeys.current.set(identity, key);
    if (accepted.current) savePurchaseDraft({ quoteId: quote.quoteId, acceptance: accepted.current, issue: null,
      charge: { policyId: policy.policyId, documentHash: policy.documentHash, key } });
    setPhase({ name: 'charging', policy, busy: true, uncertain: false, key });
    try {
      const outcome = await api().chargePolicy(policy, key, current);
      if (current.aborted) return;
      if (outcome.kind === 'unauthenticated' || outcome.kind === 'consentRequired') { common(outcome, () => {}, 6); return; }
      if (outcome.kind === 'ok' && outcome.value.status === 'issued' && outcome.value.documentHash === policy.documentHash) {
        setPhase({ name: 'issued', policy: outcome.value }); say('live.issued'); return;
      }
      if (outcome.kind === 'ok' && outcome.value.documentHash === policy.documentHash && outcome.value.status === 'charged'
        && outcome.value.payment?.status === 'confirmed') { setPhase({ name: 'charged', policy: outcome.value }); return; }
      if (outcome.kind === 'ok' || outcome.kind === 'unavailable') {
        setPhase({ name: 'charging', policy, busy: false, uncertain: true, key }); return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'payment_declined') {
        setPhase({ name: 'chargeDeclined', policy }); say('live.chargeDeclined'); return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'offer_invalid') { expired(policy.offerId); return; }
      if (outcome.kind === 'rejected' && outcome.code === 'document_mismatch' && accepted.current) {
        chargeKeys.current.delete(identity); await waitForPolicy(accepted.current, true); return;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'signature_failed' && accepted.current) {
        await waitForPolicy(accepted.current); return;
      }
      fail('generic', 6);
    } catch { /* aborted: the user left the screen */ }
  }

  async function beginChallenge(policy: Policy) {
    const current = signal.current;
    if (!current || phase.name !== 'signing' || !checked || challengeBusy) return;
    setChallengeBusy(true);
    setChallengeError(null);
    try {
      const outcome = await api().beginSignatureChallenge(policy, current);
      if (current.aborted) return;
      if (outcome.kind === 'ok') { setChallenge(outcome.value); issueChallengeId.current = outcome.value.challengeId; setCode(''); }
      else if (outcome.kind === 'rejected') setChallengeError(outcome.code);
      else common(outcome, () => void beginChallenge(policy), 7);
    } finally { setChallengeBusy(false); }
  }

  async function cancelChallenge(policy: Policy) {
    if (!challenge || !signal.current) return;
    const outcome = await api().cancelSignatureChallenge(policy.policyId, challenge.challengeId, signal.current);
    if (outcome.kind === 'ok') { setChallenge(null); issueChallengeId.current = null; setCode(''); setChecked(false); setChallengeError(null); }
    else if (outcome.kind === 'rejected') setChallengeError(outcome.code);
    else common(outcome, () => void cancelChallenge(policy), 7);
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
    {phase.name === 'review' && <PolicyDocument heading={heading} policy={phase.policy} stage="review" checked={checked} documentChanged={phase.documentChanged}
      challenge={challenge} code={code} busy={challengeBusy} error={challengeError}
      onCode={setCode} onCheck={setChecked} onBegin={() => void beginChallenge(phase.policy)}
      onCancel={() => void cancelChallenge(phase.policy)} onConfirm={() => void issue(phase.policy)}
      onContinue={() => void charge(phase.policy)} />}
    {phase.name === 'charging' && <ChargePending heading={heading} policy={phase.policy} idempotencyKey={phase.key}
      busy={phase.busy} uncertain={phase.uncertain} onRefresh={() => void charge(phase.policy)} />}
    {phase.name === 'awaitingPayment' && <section className="step card">
      <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.pendingTitle')}</h1>
      <p>{t('charge.integrationPending')}</p>
      <div className="actions"><button type="button" className="btn btn-primary" onClick={() => accepted.current && void waitForPolicy(accepted.current, false, true)}>{t('policy.refresh')}</button></div>
    </section>}
    {phase.name === 'charged' && <ChargeConfirmed heading={heading} policy={phase.policy}
      onContinue={() => { setChecked(false); setChallenge(null); setCode(''); setPhase({ name: 'signing', policy: phase.policy, busy: false, uncertain: false }); }} />}
    {phase.name === 'signing' && <>
      <PolicyDocument heading={heading} policy={phase.policy} stage="sign" checked={checked} documentChanged={false}
        challenge={challenge} code={code} busy={challengeBusy || phase.busy} error={challengeError}
        onCode={setCode} onCheck={setChecked} onBegin={() => void beginChallenge(phase.policy)}
        onCancel={() => void cancelChallenge(phase.policy)} onConfirm={() => void issue(phase.policy)} onContinue={() => {}} />
      {phase.uncertain && <div className="banner banner-error" role="alert">
        <p>{t('policy.uncertain')}</p>
        <button type="button" className="btn btn-secondary" aria-disabled={phase.busy} onClick={phase.busy ? undefined : () => void issue(phase.policy)}>{t('policy.refresh')}</button>
      </div>}
    </>}
    {phase.name === 'chargeDeclined' && <ChargeDeclined heading={heading} policy={phase.policy} onRetry={onRequote} onBack={onBack} />}
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
