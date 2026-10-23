import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { useAnnounce } from '../quote/Live';
import { newIdempotencyKey } from '../quote/api';
import { createMortgageOffer, type MortgageOffer, type OfferOutcome } from './api';

type Load = 'loading' | 'ready' | 'unavailable' | 'consentRequired' | 'notFound' | 'declined' | 'expired' | 'conflict';

export function OfferStep({ quoteId, request = createMortgageOffer, onBack, onRestartQuote = onBack, onSessionLost }: {
  quoteId: string;
  request?: (quoteId: string, key: string, signal?: AbortSignal) => Promise<OfferOutcome>;
  onBack: () => void;
  onRestartQuote?: () => void;
  onSessionLost?: () => void;
}) {
  const intl = useIntl();
  const { copDecimal, dateTime } = useFormatters();
  const announce = useAnnounce();
  const [load, setLoad] = useState<Load>('loading');
  const [offer, setOffer] = useState<MortgageOffer | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<AbortController | null>(null);
  const key = useRef(newIdempotencyKey());

  async function loadOffer() {
    pending.current?.abort();
    pending.current = new AbortController();
    setLoad('loading');
    try {
      const outcome = await request(quoteId, key.current, pending.current.signal);
      if (outcome.kind === 'offer') {
        setOffer(outcome.offer);
        setLoad('ready');
        announce(intl.formatMessage({ id: outcome.offer.status === 'preliminary' ? 'live.offerPreliminary' : 'live.offerReady' }, { premium: copDecimal(outcome.offer.premium) }));
      } else if (outcome.kind === 'unauthenticated') {
        announce(intl.formatMessage({ id: 'live.sessionExpired' }));
        onSessionLost?.();
      } else {
        setLoad(outcome.kind);
        announce(intl.formatMessage({ id: `live.offer.${outcome.kind}` }));
      }
    } catch { /* aborted when leaving the screen */ }
  }

  // The request is keyed to quoteId; callback identities must not restart this financial command.
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => { void loadOffer(); return () => pending.current?.abort(); }, [quoteId]);
  useEffect(() => { if (load !== 'loading') heading.current?.focus(); }, [load]);

  if (load === 'loading') return <section className="step card" aria-busy="true">
    <h1 className="h-card">{intl.formatMessage({ id: 'offer.loading' })}</h1>
    <p>{intl.formatMessage({ id: 'offer.loadingDetail' })}</p>
  </section>;

  if (load !== 'ready' || !offer) return <section className="step">
    <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'offer.title' })}</h1>
    <div className="banner banner-error" role="alert"><span aria-hidden="true" className="banner-icon">!</span>
      <p>{intl.formatMessage({ id: `offer.error.${load}` })}</p>
    </div>
    <div className="actions">
      {load === 'declined' || load === 'expired'
        ? <button type="button" className="btn btn-primary" onClick={onRestartQuote}>{intl.formatMessage({ id: 'offer.restartQuote' })}</button>
        : <button type="button" className="btn btn-primary" onClick={() => void loadOffer()}>{intl.formatMessage({ id: 'offer.retry' })}</button>}
      <button type="button" className="btn btn-secondary" onClick={onBack}>{intl.formatMessage({ id: 'offer.back' })}</button>
    </div>
  </section>;

  const preliminary = offer.status === 'preliminary';
  return <section className="step">
    {preliminary && <div className="banner banner-warning" role="status">
      <span aria-hidden="true" className="banner-icon">!</span>
      <div><strong>{intl.formatMessage({ id: 'offer.preliminaryTitle' })}</strong><p>{intl.formatMessage({ id: 'offer.preliminaryDetail' })}</p></div>
    </div>}
    <div className="card offer-card">
      <div className="result-head">
        <div>
          <p className="section-label">{intl.formatMessage({ id: 'offer.label' })}</p>
          <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'offer.title' })}</h1>
          <p className="mono offer-id">{offer.offerId}</p>
        </div>
        <span className={`pill ${preliminary ? 'pill-warning' : 'pill-status-active'}`}>{intl.formatMessage({ id: `offer.status.${offer.status}` })}</span>
      </div>
      <dl className="offer-summary">
        <div><dt>{intl.formatMessage({ id: 'offer.premium' })}</dt><dd className="offer-premium">{copDecimal(offer.premium)}</dd></div>
        <div><dt>{intl.formatMessage({ id: 'offer.coverage' })}</dt><dd>{copDecimal(offer.coverage.sumInsured)}</dd></div>
        <div><dt>{intl.formatMessage({ id: 'offer.validity' })}</dt><dd>{dateTime(new Date(offer.expiresAt))}</dd></div>
        <div><dt>{intl.formatMessage({ id: 'offer.rule' })}</dt><dd className="mono">{offer.ruleVersion}</dd></div>
      </dl>
      <p className="note">{intl.formatMessage({ id: 'offer.synthetic' })}</p>
      <div className="actions">
        {preliminary
          ? <button type="button" className="btn btn-primary" disabled>{intl.formatMessage({ id: 'offer.acceptBlocked' })}</button>
          : <p className="offer-next">{intl.formatMessage({ id: 'offer.definitiveNext' })}</p>}
        <button type="button" className="btn btn-secondary" onClick={onBack}>{intl.formatMessage({ id: 'offer.back' })}</button>
      </div>
    </div>
  </section>;
}
