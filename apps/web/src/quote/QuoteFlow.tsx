import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { consentApi, reconcileConsent, type Consent, type ConsentApi } from '../consent/api';
import { ConsentStep } from '../consent/ConsentStep';
import { ConsentDeclined, ConsentGranted } from '../consent/ConsentOutcome';
import { useFormatters, useLocale } from '../i18n/I18n';
import { financialApi, type FinancialApi } from '../offer/api';
import { OfferJourney } from '../offer/OfferJourney';
import { readPurchaseDraft } from '../offer/purchase-draft';
import { newIdempotencyKey, requestQuote as defaultRequest, type Quote, type QuoteValues } from './api';
import { checkLocally, fromServer, type FieldKey, type FieldProblem } from './fields';
import { useAnnounce } from './Live';
import { QuoteForm } from './QuoteForm';
import { Denied, Loading, QuoteResult } from './QuoteResult';
import { Stepper } from './Stepper';
import { invalidEstimateFields, type EstimateValues } from './estimate-api';

type Phase = 'form' | 'loading' | 'result' | 'denied' | 'consent' | 'declined' | 'granted' | 'offer';
const empty: QuoteValues = { fullName: '', documentNumber: '', birthDate: '', city: '', amount: '', termMonths: '' };

export function QuoteFlow({ request = defaultRequest, consent = consentApi, financial = financialApi, initialEstimate, consentUpdates = {}, uncertainConsents = {}, onOpenPrivacy, onSessionLost }: {
  initialEstimate?: EstimateValues | null;
  request?: typeof defaultRequest;
  consent?: Pick<ConsentApi, 'getTerms' | 'grantConsent' | 'declineConsent'>;
  financial?: FinancialApi;
  consentUpdates?: Readonly<Record<string, Consent>>;
  uncertainConsents?: Readonly<Record<string, boolean>>;
  onOpenPrivacy?: () => void;
  onSessionLost?: () => void;
}) {
  const intl = useIntl();
  const { locale } = useLocale();
  const { cop } = useFormatters();
  const announce = useAnnounce();
  // A purchase interrupted by a reload resumes at its policy; the form data itself is never stored.
  const [resume] = useState(readPurchaseDraft);
  const [phase, setPhase] = useState<Phase>(resume ? 'offer' : 'form');
  const [values, setValues] = useState<QuoteValues>(() => initialEstimate ? { ...empty, amount: initialEstimate.amount, termMonths: initialEstimate.termMonths } : empty);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [banner, setBanner] = useState<'none' | 'fields' | 'unavailable' | 'conflict'>('none');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [granted, setGranted] = useState<Consent | null>(null);
  const currentConsent = granted ? reconcileConsent(consentUpdates[granted.consentId], granted) : null;
  const [deniedTrace, setDeniedTrace] = useState<string | undefined>();
  // A retry of the same data reuses the key, so a repeated click never creates two quotes.
  const key = useRef(newIdempotencyKey());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  function change(field: FieldKey, value: string) {
    key.current = newIdempotencyKey();
    setValues(current => ({ ...current, [field]: value }));
  }

  async function submit(next: 'result' | 'offer' = 'result') {
    const local = checkLocally(values);
    if (local.length) { setProblems(local); setBanner('fields'); announce(intl.formatMessage({ id: 'live.quoteError' })); return; }
    setProblems([]); setBanner('none'); setPhase('loading');
    announce(intl.formatMessage({ id: 'live.calculating' }));
    pending.current?.abort();
    pending.current = new AbortController();
    try {
      const outcome = await request(values, key.current, locale, pending.current.signal);
      if (outcome.kind === 'quote') {
        setQuote(outcome.quote); setPhase(next);
        announce(intl.formatMessage({ id: 'live.quoteReady' }, { premium: cop(outcome.quote.premiumMonthly) }));
      } else if (outcome.kind === 'unauthenticated') {
        setPhase('form'); announce(intl.formatMessage({ id: 'live.sessionExpired' })); onSessionLost?.();
      } else if (outcome.kind === 'denied') {
        setDeniedTrace(outcome.traceId); setPhase('denied'); announce(intl.formatMessage({ id: 'live.authError' }));
      } else if (outcome.kind === 'validation') {
        const mapped = fromServer(outcome.errors);
        setProblems(mapped); setBanner(mapped.length ? 'fields' : 'unavailable'); setPhase('form');
        announce(intl.formatMessage({ id: mapped.length ? 'live.quoteError' : 'live.unavailable' }));
      } else {
        setBanner(outcome.kind === 'conflict' ? 'conflict' : 'unavailable'); setPhase('form');
        if (outcome.kind === 'conflict') key.current = newIdempotencyKey();
        announce(intl.formatMessage({ id: 'live.unavailable' }));
      }
    } catch { /* aborted: the user left the screen */ }
  }

  // Requoting after an expired offer saves a new quote from the same form data, then requests a fresh offer for it.
  function requote() {
    key.current = newIdempotencyKey();
    if (checkLocally(values).length) { setPhase('form'); return; }
    void submit('offer');
  }

  return <>
    {phase !== 'offer' && <Stepper current={phase === 'form' || phase === 'loading' || phase === 'denied' ? 1 : phase === 'result' ? 2 : 3} available={3} />}
    {phase === 'form' && initialEstimate && !invalidEstimateFields(initialEstimate).length && <p className="banner banner-info">{intl.formatMessage({ id: 'estimate.resumed' }, { age: initialEstimate.ageYears })}</p>}
    {(phase === 'form') && <QuoteForm values={values} problems={problems} banner={banner} busy={false} onChange={change} onSubmit={() => void submit()} />}
    {phase === 'loading' && <Loading />}
    {phase === 'result' && quote && <QuoteResult quote={quote} onFix={() => setPhase('form')} onContinue={() => setPhase('consent')} />}
    {phase === 'consent' && quote && <ConsentStep quoteRef={quote.quoteId} api={consent} onGranted={result => { setGranted(result); setPhase('granted'); }} onDeclined={() => setPhase('declined')} onSessionLost={onSessionLost} />}
    {phase === 'granted' && currentConsent && <ConsentGranted consent={currentConsent} uncertain={uncertainConsents[currentConsent.consentId]} onPanel={onOpenPrivacy} onBack={() => setPhase('result')} onOffer={() => setPhase('offer')} />}
    {phase === 'offer' && quote && <OfferJourney key={quote.quoteId} quote={quote} api={financial} onRequote={requote} onConsentRequired={() => setPhase('consent')} onBack={() => setPhase('result')} onSessionLost={onSessionLost} />}
    {phase === 'offer' && !quote && resume && <OfferJourney key={resume.quoteId} quote={{ quoteId: resume.quoteId }} resume={resume} api={financial} onRequote={requote}
      onConsentRequired={() => setPhase('form')} onBack={() => setPhase('form')} onSessionLost={onSessionLost} />}
    {phase === 'declined' && quote && <ConsentDeclined premium={quote.premiumMonthly} onReview={() => setPhase('consent')} onBack={() => setPhase('result')} />}
    {phase === 'denied' && <Denied traceId={deniedTrace} onRetry={() => void submit()} onBack={() => setPhase('form')} />}
  </>;
}
