import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { approvedAmount, claimPayment, type ClaimPayment, type PaymentResult } from './disbursement-api';

type Props = { claimId: string; paid: boolean; onSessionLost(): void; onConfirmed(): void };

export function ClaimDisbursement({ claimId, paid, onSessionLost, onConfirmed }: Props) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `claims.payment.${key}` });
  const [payment, setPayment] = useState<ClaimPayment>();
  const [amount, setAmount] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [canRequest, setCanRequest] = useState(false);
  const locked = useRef(false);
  const intent = useRef<string | null>(null);
  const command = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSessionLost, onConfirmed });
  useEffect(() => { callbacks.current = { onSessionLost, onConfirmed }; }, [onSessionLost, onConfirmed]);
  useEffect(() => () => { command.current?.abort(); }, []);

  const apply = useCallback((result: PaymentResult) => {
    setLoading(false);
    if (result.kind === 'ok') {
      setPayment(result.payment); setError(''); setCanRequest(false);
      if (result.payment.status === 'confirmed' && !paid) callbacks.current.onConfirmed();
    } else if (result.kind === 'unauthenticated') {
      command.current?.abort(); setBusy(false); setReviewing(false);
      setPayment(undefined); intent.current = null; setAmount(''); setCanRequest(false); callbacks.current.onSessionLost();
    } else if (result.kind === 'forbidden') {
      command.current?.abort(); setBusy(false); setReviewing(false);
      setPayment(undefined); intent.current = null; setAmount(''); setCanRequest(false); setError('forbidden');
    } else if (result.kind === 'missing' && !paid && !intent.current) { setPayment(undefined); setError(''); setCanRequest(true); }
    else { setPayment(undefined); setError(result.kind); setCanRequest(result.kind === 'invalid_amount'); }
  }, [paid]);

  useEffect(() => {
    const abort = new AbortController();
    const visible = document.visibilityState !== 'hidden';
    setHidden(!visible);
    if (visible) {
      setLoading(true);
      void claimPayment(claimId, abort.signal).then(result => { if (!abort.signal.aborted) apply(result); });
    }
    const visibility = () => { setHidden(document.visibilityState === 'hidden'); setRevision(n => n + 1); };
    document.addEventListener('visibilitychange', visibility);
    return () => { abort.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [claimId, apply, revision]);

  useEffect(() => {
    if (payment?.status !== 'pending' || hidden || error) return;
    const timer = setTimeout(() => setRevision(n => n + 1), 5000);
    return () => clearTimeout(timer);
  }, [payment, hidden, error]);

  async function authorize() {
    if (locked.current) return;
    const value = intent.current ?? approvedAmount(amount);
    if (!value) { setError('invalid_amount'); return; }
    intent.current = value; locked.current = true; setBusy(true); setError('');
    const abort = new AbortController(); command.current = abort;
    const result = await claimPayment(claimId, abort.signal, value);
    if (!abort.signal.aborted) {
      apply(result); setBusy(false);
      if (result.kind === 'invalid_amount') { intent.current = null; setReviewing(false); }
    }
    locked.current = false;
  }

  const value = intent.current ?? approvedAmount(amount);
  function format(value: string) {
    const [whole, fraction] = value.split('.');
    const separator = new Intl.NumberFormat(intl.locale).formatToParts(1.1).find(p => p.type === 'decimal')?.value ?? ',';
    return new Intl.NumberFormat(intl.locale).format(BigInt(whole)) + separator + fraction + ' COP';
  }
  return <aside className="case-card claim-payment" aria-labelledby="claim-payment-title">
    <h2 id="claim-payment-title">{t('title')}</h2>
    {hidden ? <p role="status">{t('hidden')}</p> : loading ? <p role="status">{t('loading')}</p> : <>
      {payment && <><p role="status" className={'claims-badge claim-payment-' + payment.status}>{t(payment.status)}</p>
        <p className="claim-payment-amount">{format(payment.amount)}</p>
        <p className="note">{t('simulated')}</p>
        {payment.reference && <dl className="case-fields"><div><dt>{t('reference')}</dt><dd className="mono">{payment.reference}</dd></div></dl>}
        {payment.status === 'pending' && <p role="status">{t('pendingHelp')}</p>}
      </>}
      {!payment && !paid && (canRequest || intent.current) && error !== 'forbidden' && <form onSubmit={event => {
        event.preventDefault();
        if (reviewing || intent.current) void authorize();
        else if (approvedAmount(amount)) { setReviewing(true); setError(''); }
        else setError('invalid_amount');
      }}>
        {reviewing || intent.current ? <><p>{t('review')}</p>{value && <p className="claim-payment-amount">{format(value)}</p>}
          <p className="note">{t('simulated')}</p>
          <button className="btn btn-primary" disabled={busy || !value}>{t(intent.current ? 'retrySame' : 'authorize')}</button>
          {!intent.current && <button type="button" className="btn btn-secondary" onClick={() => setReviewing(false)}>{t('edit')}</button>}
        </> : <><label>{t('amount')}<input type="text" inputMode="decimal" autoComplete="off" value={amount}
          aria-describedby="claim-payment-format" disabled={busy} required maxLength={20} onChange={event => { setAmount(event.target.value); setError(''); }} /></label>
          <p id="claim-payment-format" className="note">{t('format')}</p>
          <button className="btn btn-primary" disabled={busy}>{t('reviewButton')}</button>
        </>}
      </form>}
      {error && <p role="alert" className="claims-error">{t('error.' + error)}</p>}
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setPayment(undefined); setError(''); setLoading(true); setRevision(n => n + 1); }}>{t('refresh')}</button>
    </>}
  </aside>;
}
