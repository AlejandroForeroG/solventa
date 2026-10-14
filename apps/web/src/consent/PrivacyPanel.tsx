import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { useAnnounce } from '../quote/Live';
import { consentApi, reconcileConsent, type Consent, type ConsentApi } from './api';

type Load = 'loading' | 'ready' | 'error';

export function PrivacyPanel({ api = consentApi, onBack, onSessionLost, onConsentsChanged, onConsentUncertain }: {
  api?: Pick<ConsentApi, 'listConsents' | 'revokeConsent'>;
  onBack: () => void;
  onSessionLost?: () => void;
  onConsentsChanged?: (items: Consent[]) => void;
  onConsentUncertain?: (id: string) => void;
}) {
  const intl = useIntl();
  const { shortDate } = useFormatters();
  const announce = useAnnounce();
  const announcement = useRef({ intl, announce });
  useLayoutEffect(() => { announcement.current = { intl, announce }; }, [intl, announce]);
  const announceCurrent = useCallback((id: string, values?: Record<string, string>) => {
    const current = announcement.current;
    current.announce(current.intl.formatMessage({ id }, values));
  }, []);
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<Consent[]>([]);
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);
  const operationPending = useRef(false);
  const mutationEpoch = useRef(0);
  const mounted = useRef(true);
  const after = pageCursors[pageCursors.length - 1];

  const fetchItems = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    const epoch = mutationEpoch.current;
    pending.current = controller;
    try {
      const outcome = await api.listConsents(controller.signal, after);
      if (controller.signal.aborted || epoch !== mutationEpoch.current) return;
      if (outcome.kind === 'ok') {
        setItems(current => outcome.value.items.map(item => reconcileConsent(current.find(observed => observed.consentId === item.consentId), item)));
        setNextCursor(outcome.value.nextCursor); setLoad('ready');
        setConfirming(current => current && outcome.value.items.some(item => item.consentId === current && item.status === 'active') ? current : null);
        onConsentsChanged?.(outcome.value.items);
      }
      else if (outcome.kind === 'unauthenticated') onSessionLost?.();
      else { setLoad('error'); announceCurrent('live.privacyError'); }
    } catch { /* aborted: the user left the screen */ }
  }, [api, announceCurrent, onSessionLost, onConsentsChanged, after]);

  const reload = useCallback(() => { setLoad('loading'); void fetchItems(); }, [fetchItems]);
  useEffect(() => { if (!operationPending.current) void fetchItems(); }, [fetchItems, intl]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); };
  }, []);
  useEffect(() => { heading.current?.focus(); announce(intl.formatMessage({ id: 'live.privacy' })); }, [announce, intl]);
  useEffect(() => { if (load === 'ready') heading.current?.focus(); }, [load]);
  useEffect(() => { if (confirming) confirmButton.current?.focus(); }, [confirming]);

  function changePage(cursors: (string | undefined)[]) {
    setConfirming(null); setFailed(null); setLoad('loading'); setPageCursors(cursors);
  }

  async function revoke(id: string) {
    operationPending.current = true;
    mutationEpoch.current++;
    onConsentUncertain?.(id);
    setBusy(true); setFailed(null);
    try {
      const outcome = await api.revokeConsent(id);
      if (!mounted.current) return;
      // Reads started before the write finished cannot confirm its outcome.
      mutationEpoch.current++;
      if (outcome.kind === 'ok') {
        setItems(current => current.map(item => item.consentId === id ? outcome.value : item));
        onConsentsChanged?.([outcome.value]);
        setConfirming(null);
        announceCurrent('live.revoked', { id });
      } else if (outcome.kind === 'unauthenticated') {
        onSessionLost?.();
      } else {
        if (outcome.kind === 'notFound' || outcome.kind === 'conflict') setConfirming(null);
        else { setFailed(id); announceCurrent('live.revokeError', { id }); }
        // The write may have committed before its response was lost.
        await fetchItems();
      }
    } finally {
      operationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="step privacy">
    <h1 ref={heading} tabIndex={-1}>{intl.formatMessage({ id: 'privacy.title' })}</h1>
    <p className="lede">{intl.formatMessage({ id: 'privacy.lede' })}</p>
    {load === 'loading' && <p aria-busy="true">{intl.formatMessage({ id: 'privacy.loading' })}</p>}
    {load === 'error' && <div>
      <div className="banner banner-error"><span aria-hidden="true" className="banner-icon">!</span><p>{intl.formatMessage({ id: 'privacy.error' })}</p></div>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={reload}>{intl.formatMessage({ id: 'consent.retry' })}</button>
    </div>}
    {load === 'ready' && items.length === 0 && <p className="note">{intl.formatMessage({ id: 'privacy.empty' })}</p>}
    {load === 'ready' && items.length > 0 && <ul className="consents">
      {items.map(item => {
        const from = shortDate(new Date(item.grantedAt));
        const sources = item.sources.map(code => intl.formatMessage({ id: `source.${code}.name`, defaultMessage: code })).join(' · ');
        const scopes = item.scopes.map(code => intl.formatMessage({ id: `scope.${code}`, defaultMessage: code })).join(' · ');
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
            <p className="note">{intl.formatMessage({ id: 'privacy.scopes' }, { scopes })}</p>
            <p className="mono seal-line">{period} · {intl.formatMessage({ id: 'privacy.seal' })} {item.seal.slice(0, 4)}…{item.seal.slice(-4)}</p>
          </div>
          {item.status === 'active' && confirming !== item.consentId &&
            <button type="button" className="btn btn-danger" disabled={busy} aria-label={intl.formatMessage({ id: 'privacy.revokeLabel' }, { id: item.consentId })} onClick={() => { setConfirming(item.consentId); setFailed(null); }}>
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
    {load === 'ready' && (pageCursors.length > 1 || nextCursor) && <div className="actions">
      {pageCursors.length > 1 && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => changePage(pageCursors.slice(0, -1))}>{intl.formatMessage({ id: 'privacy.previous' })}</button>}
      {nextCursor && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => changePage([...pageCursors, nextCursor])}>{intl.formatMessage({ id: 'privacy.next' })}</button>}
    </div>}
    <p className="note privacy-foot">{intl.formatMessage({ id: 'privacy.foot' })}</p>
    <div className="actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={onBack}>{intl.formatMessage({ id: 'privacy.back' })}</button></div>
  </section>;
}
