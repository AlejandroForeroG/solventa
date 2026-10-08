import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { useAnnounce } from '../quote/Live';
import { consentApi, type Consent, type ConsentApi } from './api';

type Load = 'loading' | 'ready' | 'error';

export function PrivacyPanel({ api = consentApi, onBack, onSessionLost }: {
  api?: Pick<ConsentApi, 'listConsents' | 'revokeConsent'>;
  onBack: () => void;
  onSessionLost?: () => void;
}) {
  const intl = useIntl();
  const { shortDate } = useFormatters();
  const announce = useAnnounce();
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<Consent[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);

  const fetchItems = useCallback(async () => {
    pending.current?.abort();
    pending.current = new AbortController();
    try {
      const outcome = await api.listConsents(pending.current.signal);
      if (outcome.kind === 'ok') { setItems(outcome.value); setLoad('ready'); }
      else if (outcome.kind === 'unauthenticated') onSessionLost?.();
      else { setLoad('error'); announce(intl.formatMessage({ id: 'live.privacyError' })); }
    } catch { /* aborted: the user left the screen */ }
  }, [api, announce, intl, onSessionLost]);

  const reload = useCallback(() => { setLoad('loading'); void fetchItems(); }, [fetchItems]);
  useEffect(() => { void fetchItems(); return () => pending.current?.abort(); }, [fetchItems]);
  useEffect(() => { heading.current?.focus(); announce(intl.formatMessage({ id: 'live.privacy' })); }, [announce, intl]);
  useEffect(() => { if (confirming) confirmButton.current?.focus(); }, [confirming]);

  async function revoke(id: string) {
    setBusy(true); setFailed(null);
    const outcome = await api.revokeConsent(id);
    setBusy(false);
    if (outcome.kind === 'ok') {
      setItems(current => current.map(item => item.consentId === id ? outcome.value : item));
      setConfirming(null);
      announce(intl.formatMessage({ id: 'live.revoked' }, { id }));
    } else if (outcome.kind === 'unauthenticated') {
      onSessionLost?.();
    } else if (outcome.kind === 'notFound' || outcome.kind === 'conflict') {
      setConfirming(null); reload();
    } else {
      setFailed(id); announce(intl.formatMessage({ id: 'live.revokeError' }, { id }));
    }
  }

  return <section className="step privacy">
    <h1 ref={heading} tabIndex={-1}>{intl.formatMessage({ id: 'privacy.title' })}</h1>
    <p className="lede">{intl.formatMessage({ id: 'privacy.lede' })}</p>
    {load === 'loading' && <p aria-busy="true">{intl.formatMessage({ id: 'privacy.loading' })}</p>}
    {load === 'error' && <div>
      <div className="banner banner-error"><span aria-hidden="true" className="banner-icon">!</span><p>{intl.formatMessage({ id: 'privacy.error' })}</p></div>
      <button type="button" className="btn btn-secondary" onClick={reload}>{intl.formatMessage({ id: 'consent.retry' })}</button>
    </div>}
    {load === 'ready' && items.length === 0 && <p className="note">{intl.formatMessage({ id: 'privacy.empty' })}</p>}
    {load === 'ready' && items.length > 0 && <ul className="consents">
      {items.map(item => {
        const from = shortDate(new Date(item.grantedAt));
        const sources = item.sources.map(code => intl.formatMessage({ id: `source.${code}.name`, defaultMessage: code })).join(' · ');
        const period = item.revokedAt
          ? intl.formatMessage({ id: 'privacy.periodRevoked' }, { from, date: shortDate(new Date(item.revokedAt)) })
          : intl.formatMessage({ id: 'privacy.period' }, { from, to: shortDate(new Date(item.expiresAt)) });
        return <li key={item.consentId} className="consent-item">
          <div className="consent-item-main">
            <div className="consent-item-head">
              <span className="mono-value">{item.consentId}</span>
              <span className={`pill pill-status-${item.status}`}>{intl.formatMessage({ id: `status.${item.status}` })}</span>
            </div>
            <p className="consent-item-purpose">{intl.formatMessage({ id: 'consent.purposeShort' })}</p>
            <p className="note">{sources}</p>
            <p className="mono seal-line">{period} · {intl.formatMessage({ id: 'privacy.seal' })} {item.seal.slice(0, 4)}…{item.seal.slice(-4)}</p>
          </div>
          {item.status === 'active' && confirming !== item.consentId &&
            <button type="button" className="btn btn-danger" aria-label={intl.formatMessage({ id: 'privacy.revokeLabel' }, { id: item.consentId })} onClick={() => { setConfirming(item.consentId); setFailed(null); }}>
              {intl.formatMessage({ id: 'privacy.revoke' })}
            </button>}
          {confirming === item.consentId && <div className="confirm" role="group" aria-label={intl.formatMessage({ id: 'privacy.confirmTitle' }, { id: item.consentId })}>
            <p><strong>{intl.formatMessage({ id: 'privacy.confirmTitle' }, { id: item.consentId })}</strong></p>
            <p className="note">{intl.formatMessage({ id: 'privacy.confirmDetail' })}</p>
            {failed === item.consentId && <p className="field-error">{intl.formatMessage({ id: 'privacy.revokeError' }, { id: item.consentId })}</p>}
            <div className="actions">
              <button ref={confirmButton} type="button" className="btn btn-primary" disabled={busy} onClick={() => void revoke(item.consentId)}>{intl.formatMessage({ id: 'privacy.confirm' })}</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setConfirming(null); setFailed(null); }}>{intl.formatMessage({ id: 'privacy.cancel' })}</button>
            </div>
          </div>}
        </li>;
      })}
    </ul>}
    <p className="note privacy-foot">{intl.formatMessage({ id: 'privacy.foot' })}</p>
    <div className="actions"><button type="button" className="btn btn-secondary" onClick={onBack}>{intl.formatMessage({ id: 'privacy.back' })}</button></div>
  </section>;
}
