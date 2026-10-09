import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { consentApi, type Consent, type ConsentApi } from '../consent/api';
import { ConsentStep } from '../consent/ConsentStep';
import { ConsentDeclined, ConsentGranted } from '../consent/ConsentOutcome';
import { useFormatters, useLocale } from '../i18n/I18n';
import { newIdempotencyKey, requestQuote as defaultRequest, type Quote, type QuoteValues } from './api';
import { checkLocally, fromServer, type FieldKey, type FieldProblem } from './fields';
import { useAnnounce } from './Live';
import { QuoteForm } from './QuoteForm';
import { Denied, Loading, QuoteResult } from './QuoteResult';
import { Stepper } from './Stepper';

type Phase = 'form' | 'loading' | 'result' | 'denied' | 'consent' | 'declined' | 'granted';
const empty: QuoteValues = { fullName: '', documentNumber: '', birthDate: '', city: '', amount: '', termMonths: '' };

export function QuoteFlow({ request = defaultRequest, consent = consentApi, onOpenPrivacy, onSessionLost }: {
  request?: typeof defaultRequest;
  consent?: Pick<ConsentApi, 'getTerms' | 'grantConsent' | 'declineConsent'>;
  onOpenPrivacy?: () => void;
  onSessionLost?: () => void;
}) {
  const intl = useIntl();
  const { locale } = useLocale();
  const { cop } = useFormatters();
  const announce = useAnnounce();
  const [phase, setPhase] = useState<Phase>('form');
  const [values, setValues] = useState<QuoteValues>(empty);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [banner, setBanner] = useState<'none' | 'fields' | 'unavailable' | 'conflict'>('none');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [granted, setGranted] = useState<Consent | null>(null);
  const [deniedTrace, setDeniedTrace] = useState<string | undefined>();
  // A retry of the same data reuses the key, so a repeated click never creates two quotes.
  const key = useRef(newIdempotencyKey());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  function change(field: FieldKey, value: string) {
    key.current = newIdempotencyKey();
    setValues(current => ({ ...current, [field]: value }));
  }

  async function submit() {
    const local = checkLocally(values);
    if (local.length) { setProblems(local); setBanner('fields'); announce(intl.formatMessage({ id: 'live.quoteError' })); return; }
    setProblems([]); setBanner('none'); setPhase('loading');
    announce(intl.formatMessage({ id: 'live.calculating' }));
    pending.current?.abort();
    pending.current = new AbortController();
    try {
      const outcome = await request(values, key.current, locale, pending.current.signal);
      if (outcome.kind === 'quote') {
        setQuote(outcome.quote); setPhase('result');
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

  return <>
    <Stepper current={phase === 'form' || phase === 'loading' || phase === 'denied' ? 1 : phase === 'result' ? 2 : 3} available={3} />
    {(phase === 'form') && <QuoteForm values={values} problems={problems} banner={banner} busy={false} onChange={change} onSubmit={() => void submit()} />}
    {phase === 'loading' && <Loading />}
    {phase === 'result' && quote && <QuoteResult quote={quote} onFix={() => setPhase('form')} onContinue={() => setPhase('consent')} />}
    {phase === 'consent' && quote && <ConsentStep quoteRef={quote.quoteId} api={consent} onGranted={result => { setGranted(result); setPhase('granted'); }} onDeclined={() => setPhase('declined')} onSessionLost={onSessionLost} />}
    {phase === 'granted' && granted && <ConsentGranted consent={granted} onPanel={onOpenPrivacy} onBack={() => setPhase('result')} />}
    {phase === 'declined' && quote && <ConsentDeclined premium={quote.premiumMonthly} onReview={() => setPhase('consent')} onBack={() => setPhase('result')} />}
    {phase === 'denied' && <Denied traceId={deniedTrace} onRetry={() => void submit()} onBack={() => setPhase('form')} />}
  </>;
}
