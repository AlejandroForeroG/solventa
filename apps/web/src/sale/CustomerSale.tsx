import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { OfferJourney } from '../offer/OfferJourney';
import { readOffer, type Offer } from '../offer/api';
import { grantSaleAuthorization, listSaleAuthorizations, revokeSaleAuthorization, uuid, type Outcome, type SaleAuthorization } from './api';
import '../policies/policies.css';

type Load = { kind: 'loading' } | { kind: 'ready'; items: SaleAuthorization[] } | { kind: 'failed'; reason: string };

function Authorizations({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl(), t = (key: string) => intl.formatMessage({ id: `sale.${key}` });
  const [load, setLoad] = useState<Load>({ kind: 'loading' }), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [reference, setReference] = useState(''), [days, setDays] = useState(1), [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void listSaleAuthorizations(abort.signal).then(outcome => {
      if (abort.signal.aborted) return;
      if (outcome.kind === 'unauthenticated') onSessionLost();
      setLoad(outcome.kind === 'ok' ? { kind: 'ready', items: outcome.value } : { kind: 'failed', reason: outcome.kind });
    }).catch(() => { if (!abort.signal.aborted) setLoad({ kind: 'failed', reason: 'unavailable' }); });
    return () => abort.abort();
  }, [refresh, onSessionLost]);
  const timestamp = (value: string) => intl.formatDate(value, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  async function run(work: () => Promise<Outcome<unknown>>) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const outcome = await work();
      if (outcome.kind === 'unauthenticated') onSessionLost();
      if (outcome.kind === 'ok') { setConfirmed(false); setReference(''); setLoad({ kind: 'loading' }); setRefresh(value => value + 1); } else setError(outcome.kind);
    } catch { setError('unavailable'); }
    finally { setBusy(false); }
  }
  const valid = uuid(reference) && confirmed;
  return <section className="card policy-section" aria-labelledby="sale-authorizations-heading">
    <h2 id="sale-authorizations-heading" className="h-card">{t('authorizeTitle')}</h2>
    <p className="note">{t('authorizeScope')}</p>
    <form onSubmit={event => { event.preventDefault(); if (valid) void run(() => grantSaleAuthorization({ advisorReference: reference.toLowerCase(), validityDays: days })); }}>
      <label className="field">{t('reference')}<input required value={reference} disabled={busy} autoComplete="off" onChange={event => { setReference(event.target.value.trim()); setConfirmed(false); }} /></label>
      <label className="field">{t('validity')}<select value={days} disabled={busy} onChange={event => { setDays(Number(event.target.value)); setConfirmed(false); }}>
        {[1, 2, 3, 7].map(value => <option key={value} value={value}>{intl.formatMessage({ id: 'sale.days' }, { count: value })}</option>)}</select></label>
      <div className="check"><input id="sale-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><label htmlFor="sale-confirm">{t('confirm')}</label></div>
      <button className="btn btn-secondary" type="submit" disabled={busy || !valid}>{busy ? t('saving') : t('authorize')}</button>
    </form>
    {error && <p role="alert">{t(error)}</p>}
    {load.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {load.kind === 'failed' && <p role="alert">{t(load.reason)}</p>}
    {load.kind === 'ready' && (load.items.length ? <ul className="policy-documents">{load.items.map(item => <li key={item.authorizationId}><div>
      <p>{t('advisor')}: <span className="mono">{item.advisorReference}</span></p>
      <p>{t(item.status)} · {t('expires')}: {timestamp(item.expiresAt)}</p>
      {item.revokedAt && <p>{t('revoked')}: {timestamp(item.revokedAt)}</p>}
      {item.status === 'active' && <details className="document-verification"><summary>{t('code')}</summary><p className="mono audit-id">{item.authorizationId}</p></details>}
    </div>{item.status === 'active' && <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void run(() => revokeSaleAuthorization(item.authorizationId))}>{t('revoke')}</button>}</li>)}</ul>
      : <p>{t('empty')}</p>)}
  </section>;
}

type Continue = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; offer: Offer; run: number } | { kind: 'failed'; reason: string };

function Continuation({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl(), t = (key: string) => intl.formatMessage({ id: `sale.${key}` });
  const [offerId, setOfferId] = useState(''), [state, setState] = useState<Continue>({ kind: 'idle' }), run = useRef(0);
  async function open() {
    if (!uuid(offerId)) { setState({ kind: 'failed', reason: 'invalid' }); return; }
    setState({ kind: 'loading' });
    try {
      const outcome = await readOffer(offerId.toLowerCase());
      if (outcome.kind === 'unauthenticated') onSessionLost();
      run.current += 1;
      setState(outcome.kind === 'ok' ? { kind: 'ready', offer: outcome.value, run: run.current } : { kind: 'failed', reason: outcome.kind === 'notFound' || outcome.kind === 'forbidden' ? 'offerNotFound' : outcome.kind });
    } catch { setState({ kind: 'failed', reason: 'unavailable' }); }
  }
  const back = useCallback(() => { setState({ kind: 'idle' }); setOfferId(''); }, []);
  if (state.kind === 'ready') {
    // Consent, acceptance, payment and signature are the customer's own steps, exactly as in their own purchase.
    return <OfferJourney key={state.run} quote={{ quoteId: state.offer.quoteId }} initialOffer={state.offer} onRequote={back} onBack={back} onSessionLost={onSessionLost}
      onConsentRequired={() => setState({ kind: 'failed', reason: 'consentRequired' })} />;
  }
  return <section className="card policy-section" aria-labelledby="sale-continue-heading">
    <h2 id="sale-continue-heading" className="h-card">{t('continueTitle')}</h2>
    <p className="note">{t('continueScope')}</p>
    <form onSubmit={event => { event.preventDefault(); void open(); }}>
      <label className="field">{t('offerCode')}<input required value={offerId} disabled={state.kind === 'loading'} autoComplete="off" onChange={event => setOfferId(event.target.value.trim())} /></label>
      <button className="btn btn-primary" type="submit" disabled={state.kind === 'loading'}>{state.kind === 'loading' ? t('loading') : t('openOffer')}</button>
    </form>
    {state.kind === 'failed' && <p role="alert">{t(state.reason)}</p>}
  </section>;
}

export function CustomerSalePortal({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  return <main className="content policies">
    <h1>{intl.formatMessage({ id: 'sale.title' })}</h1>
    <Authorizations onSessionLost={onSessionLost} />
    <Continuation onSessionLost={onSessionLost} />
  </main>;
}
