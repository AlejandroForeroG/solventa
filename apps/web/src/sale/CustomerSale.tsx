import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { OfferJourney } from '../offer/OfferJourney';
import { readOffer, type Offer } from '../offer/api';
import { clearPurchaseDraft, readPurchaseDraft } from '../offer/purchase-draft';
import { grantSaleAuthorization, listSaleAuthorizations, revokeSaleAuthorization, uuid, type Outcome, type SaleAuthorization } from './api';
import { CopyValue } from '../forms/CopyValue';
import '../policies/policies.css';
import './customer-sale.css';
import { Icon } from '../navigation/Icon';

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
  const timestamp = (value: string) => intl.formatDate(value, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }) + ' ' + t('bogota');
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
  return <section className="card sale-flow" aria-labelledby="sale-flow-title">
    <p className="note">{t('authorizeScope')}</p>
    <form onSubmit={event => { event.preventDefault(); if (valid) void run(() => grantSaleAuthorization({ advisorReference: reference.toLowerCase(), validityDays: days })); }}>
      <div className="grid">
      <div className="field"><label htmlFor="sale-cus-1">{t('reference')}</label><input id="sale-cus-1" required value={reference} disabled={busy} autoComplete="off" onChange={event => { setReference(event.target.value.trim()); setConfirmed(false); }} /></div>
      <div className="field"><label htmlFor="sale-cus-2">{t('validity')}</label><select id="sale-cus-2" value={days} disabled={busy} onChange={event => { setDays(Number(event.target.value)); setConfirmed(false); }}>
        {[1, 2, 3, 7].map(value => <option key={value} value={value}>{intl.formatMessage({ id: 'sale.days' }, { count: value })}</option>)}</select></div>
      </div>
      <div className="check"><input id="sale-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><label htmlFor="sale-confirm">{t('confirm')}</label></div>
      <div className="actions"><button className="btn btn-secondary" type="submit" disabled={busy || !valid}>{busy ? t('saving') : t('authorize')}</button></div>
    </form>
    {error && <p role="alert">{t(error)}</p>}
    <div className="sale-authorization-history">
    <h2 className="h-card">{t('myAuthorizations')}</h2>
    {load.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {load.kind === 'failed' && <p role="alert">{t(load.reason)}</p>}
    {load.kind === 'ready' && (load.items.length ? <>
      {load.items.some(item => item.status === 'active') && <ul className="policy-documents">{load.items.filter(item => item.status === 'active').map(item => <li key={item.authorizationId}><div>
      <p>{t('advisor')}: <span className="mono">{item.advisorReference}</span></p>
      <p>{t(item.status)} · {t('expires')}: {timestamp(item.expiresAt)}</p>
      {item.revokedAt && <p>{t('revoked')}: {timestamp(item.revokedAt)}</p>}
      {item.status === 'active' && <CopyValue label={t('code')} value={item.authorizationId} />}
    </div>{item.status === 'active' && <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void run(() => revokeSaleAuthorization(item.authorizationId))}>{t('revoke')}</button>}</li>)}</ul>}
      {load.items.some(item => item.status !== 'active') && <details className="document-verification sale-history"><summary>{t('history')}</summary>
        <ul className="policy-documents">{load.items.filter(item => item.status !== 'active').map(item => <li key={item.authorizationId}><div>
      <p>{t('advisor')}: <span className="mono">{item.advisorReference}</span></p>
      <p>{t(item.status)} · {t('expires')}: {timestamp(item.expiresAt)}</p>
      {item.revokedAt && <p>{t('revoked')}: {timestamp(item.revokedAt)}</p>}
      {item.status === 'active' && <CopyValue label={t('code')} value={item.authorizationId} />}
    </div>{item.status === 'active' && <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void run(() => revokeSaleAuthorization(item.authorizationId))}>{t('revoke')}</button>}</li>)}</ul></details>}
    </>
      : <p>{t('empty')}</p>)}
    </div>
  </section>;
}

type Continue = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; offer: Offer; run: number } | { kind: 'failed'; reason: string };

function Continuation({ onSessionLost, onOpenChange }: { onSessionLost(): void; onOpenChange(open: boolean): void }) {
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
  const back = useCallback(() => {
    setState({ kind: 'idle' }); setOfferId('');
  }, []);
  useEffect(() => { onOpenChange(state.kind === 'ready'); }, [state.kind, onOpenChange]);
  if (state.kind === 'ready') {
    // Consent, acceptance, payment and signature are the customer's own steps, exactly as in their own purchase.
    return <OfferJourney key={state.run} quote={{ quoteId: state.offer.quoteId }} initialOffer={state.offer} onRequote={back} onBack={back} onSessionLost={onSessionLost}
      onConsentRequired={() => setState({ kind: 'failed', reason: 'consentRequired' })} />;
  }
  return <section className="card sale-flow" aria-labelledby="sale-flow-title">
    <form onSubmit={event => { event.preventDefault(); void open(); }}>
      <div className="field"><label htmlFor="sale-cus-3">{t('offerCode')}</label><input id="sale-cus-3" required value={offerId} disabled={state.kind === 'loading'} autoComplete="off" onChange={event => setOfferId(event.target.value.trim())} /></div>
      <div className="actions"><button className="btn btn-primary" type="submit" disabled={state.kind === 'loading'}>{state.kind === 'loading' ? t('loading') : t('openOffer')}</button></div>
    </form>
    {state.kind === 'failed' && <p role="alert">{t(state.reason)}</p>}
  </section>;
}

const saleChoices = [
  { flow: 'continue', message: 'continueTitle', icon: 'reports' },
  { flow: 'authorize', message: 'authorizeTitle', icon: 'advisor' },
] as const;
type SaleFlow = typeof saleChoices[number]['flow'];

export function CustomerSalePortal({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `sale.${key}` });
  // A purchase interrupted by a reload resumes at its policy: the draft keeps only server references and command keys.
  const [resume, setResume] = useState(readPurchaseDraft);
  const leave = useCallback(() => { clearPurchaseDraft(); setResume(null); }, []);
  const [offerOpen, setOfferOpen] = useState(false);
  const [flow, setFlow] = useState<SaleFlow | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!offerOpen && !resume) heading.current?.focus();
  }, [flow, offerOpen, resume]);
  if (resume) {
    return <main className="content policies"><OfferJourney key={resume.quoteId} quote={{ quoteId: resume.quoteId }} resume={resume} onRequote={leave} onBack={leave} onSessionLost={onSessionLost}
      onConsentRequired={leave} /></main>;
  }
  const choice = saleChoices.find(option => option.flow === flow);
  return <main className="content policies">
    {!offerOpen && <>
      {choice && <button type="button" className="btn btn-secondary btn-small policy-back" onClick={() => setFlow(null)}>
        <Icon name="back" size={16} />{t('backToAdvisor')}
      </button>}
      <div className="page-title">
        <span className="page-icon page-icon-violet" aria-hidden="true"><Icon name={choice?.icon ?? 'advisor'} size={22} /></span>
        <h1 id="sale-flow-title" ref={heading} tabIndex={-1}>{t(choice?.message ?? 'title')}</h1>
      </div>
    </>}
    {!flow && <ul className="sale-choices" aria-labelledby="sale-flow-title">{saleChoices.map(option => <li key={option.flow}>
      <button className="sale-choice" type="button" onClick={() => setFlow(option.flow)}>
        <span className="sale-choice-icon" aria-hidden="true"><Icon name={option.icon} /></span>
        <span>{t(option.message)}</span>
        <Icon name="arrow" size={18} className="sale-choice-arrow" />
      </button>
    </li>)}</ul>}
    {flow === 'continue' && <Continuation onSessionLost={onSessionLost} onOpenChange={setOfferOpen} />}
    {flow === 'authorize' && <Authorizations onSessionLost={onSessionLost} />}
  </main>;
}
