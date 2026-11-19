import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import type { ClaimPaymentPage } from '@solventa/contracts';
import { getOwnClaimPayments } from './disbursement-api';

export function OwnClaimPayments({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `claims.payment.${key}` });
  const [page, setPage] = useState<ClaimPaymentPage>();
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const visibility = () => { setPage(undefined); setHidden(document.visibilityState === 'hidden'); setRevision(n => n + 1); };
    document.addEventListener('visibilitychange', visibility);
    if (!hidden) void getOwnClaimPayments(cursor, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      if (result.kind === 'unauthenticated') { setPage(undefined); onSessionLost(); return; }
      setPage(result.kind === 'ok' ? result.page : undefined); setError(result.kind === 'ok' ? '' : result.kind);
    });
    return () => { abort.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [cursor, hidden, onSessionLost, revision]);
  return <section className="case-card claim-payment" aria-labelledby="own-payments-title">
    <h2 id="own-payments-title">{t('ownerTitle')}</h2>
    {hidden ? <p role="status">{t('hidden')}</p> : <>
      {!page && !error && <p role="status">{t('loading')}</p>}
      {error && <p role="alert" className="claims-error">{t('error.' + error)}</p>}
      {page?.items.length === 0 && <p>{t('empty')}</p>}
      {page && <ul className="case-list">{page.items.map(item => {
        const [whole, fraction] = item.payment.amount.split('.');
        const separator = new Intl.NumberFormat(intl.locale).formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? ',';
        return <li key={item.claimId}><div>
          <a href={'/mis-siniestros/' + item.claimId}>{item.claimNumber}</a>
          <p className="claim-payment-amount">{new Intl.NumberFormat(intl.locale).format(BigInt(whole)) + separator + fraction} COP</p>
          <p className="note">{t('simulated')}</p>
          {item.payment.reference && <p className="mono">{t('reference')}: {item.payment.reference}</p>}
          <p>{t('updated')}: <time dateTime={item.updatedAt}>{intl.formatDate(item.updatedAt, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' })}</time></p>
        </div><span className={'claims-badge claim-payment-' + item.payment.status}>{t(item.payment.status)}</span></li>;
      })}</ul>}
      <div className="claims-filters">
        {previous.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => {
          setCursor(previous.at(-1)); setPrevious(items => items.slice(0, -1)); setPage(undefined); setError('');
        }}>{t('previous')}</button>}
        {page?.next && <button type="button" className="btn btn-secondary" onClick={() => {
          setPrevious(items => [...items, cursor]); setCursor(page.next ?? undefined); setPage(undefined); setError('');
        }}>{t('next')}</button>}
        <button type="button" className="btn btn-secondary" onClick={() => { setPage(undefined); setError(''); setRevision(n => n + 1); }}>{t('refresh')}</button>
      </div>
    </>}
  </section>;
}
