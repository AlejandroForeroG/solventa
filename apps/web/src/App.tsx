import { brandAssets } from '@solventa/assets/web';
import { useCallback, useEffect, useState } from 'react';
import { fetchSession, requestLogout } from './api/auth';
import type { SessionStatus } from './api/auth';
import { useIntl } from 'react-intl';
import { PrivacyPanel } from './consent/PrivacyPanel';
import { reconcileConsent, type Consent } from './consent/api';
import { I18n, useLocale } from './i18n/I18n';
import { locales } from './i18n/messages';
import { LiveRegion, useAnnounce } from './quote/Live';
import { QuoteFlow } from './quote/QuoteFlow';
import { Landing } from './landing/Landing';

type Session = 'loading' | SessionStatus;

function LocaleSwitch() {
  const intl = useIntl();
  const { locale, setLocale } = useLocale();
  return <div className="locale-switch" role="group" aria-label={intl.formatMessage({ id: 'locale.group' })}>
    {locales.map(code => <button key={code} type="button" className="locale-btn" aria-pressed={locale === code} lang={code.slice(0, 2)}
      aria-label={intl.formatMessage({ id: 'locale.switchTo' }, { language: intl.formatMessage({ id: `locale.name.${code}` }) })}
      onClick={() => setLocale(code)}>{intl.formatMessage({ id: `locale.${code}` })}</button>)}
  </div>;
}

function Shell() {
  const intl = useIntl();
  const announce = useAnnounce();
  const [session, setSession] = useState<Session>('loading');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'flow' | 'privacy'>('flow');
  const [consentUpdates, setConsentUpdates] = useState<Record<string, Consent>>({});
  const [uncertainConsents, setUncertainConsents] = useState<Record<string, boolean>>({});
  const updateConsents = useCallback((items: Consent[]) => {
    setConsentUpdates(current => ({ ...current, ...Object.fromEntries(items.map(item => [item.consentId, reconcileConsent(current[item.consentId], item)])) }));
    setUncertainConsents(current => ({ ...current, ...Object.fromEntries(items.map(item => [item.consentId, false])) }));
  }, []);
  const consentUncertain = useCallback((id: string) => setUncertainConsents(current => ({ ...current, [id]: true })), []);
  const sessionLost = useCallback(() => setSession('anonymous'), []);
  const failed = new URLSearchParams(window.location.search).get('auth') === 'failed';
  const isLanding = window.location.pathname !== '/cotizar' && !failed;
  async function load() {
    setSession('loading');
    setSession(await fetchSession());
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (session === 'loading') announce(intl.formatMessage({ id: 'session.loading' }));
    if (session === 'unavailable') announce(intl.formatMessage({ id: 'session.unavailable' }));
  }, [session, announce, intl]);
  async function logout() {
    setBusy(true);
    try {
      const result = await requestLogout();
      if (result.status === 'anonymous') { setSession('anonymous'); return; }
      window.location.assign(result.logoutUrl);
    } catch { setSession('unavailable'); }
    finally { setBusy(false); }
  }
  const t = (id: string) => intl.formatMessage({ id });
  return <div className="app-shell">
    <header className="channel-header">
      <a href="/" aria-label={t('landing.home')}><img src={brandAssets.logo.green} alt="Solventa" width={174} /></a>
      <div className="header-tools">
        <LocaleSwitch />
        {isLanding && session !== 'authenticated' && <a className="btn btn-secondary btn-small" href="/auth/login">{t('session.title')}</a>}
        {session === 'authenticated' && <button type="button" className="btn btn-secondary btn-small" onClick={() => void logout()} disabled={busy}>{busy ? t('session.loggingOut') : t('session.logout')}</button>}
      </div>
    </header>
    {isLanding ? <Landing /> : session === 'authenticated'
      ? <main className="content" aria-busy={busy}>
        <div className="channel-line"><img src={brandAssets.icon.green} alt="" width={28} height={28} /><span className="product">{t('brand.product')}</span>
          <button type="button" className="btn btn-secondary btn-small btn-privacy" onClick={() => setView('privacy')} aria-current={view === 'privacy' ? 'page' : undefined}>{t('privacy.open')}</button>
        </div>
        <div hidden={view === 'privacy'}><QuoteFlow consentUpdates={consentUpdates} uncertainConsents={uncertainConsents} onOpenPrivacy={() => setView('privacy')} onSessionLost={sessionLost} /></div>
        {view === 'privacy' && <PrivacyPanel onConsentUncertain={consentUncertain} onConsentsChanged={updateConsents} onBack={() => setView('flow')} onSessionLost={sessionLost} />}
      </main>
      : <main className="access-panel" aria-busy={session === 'loading'}>
        <h1>{t('session.title')}</h1>
        {session === 'loading' && <p>{t('session.loading')}</p>}
        {failed && <p className="error">{t('session.failed')}</p>}
        {session === 'anonymous' && <a className="primary-action" href="/auth/login">{t('session.continue')}</a>}
        {session === 'unavailable' && <><p>{t('session.unavailable')}</p><button onClick={() => void load()}>{t('session.retry')}</button></>}
      </main>}
  </div>;
}

export default function App() {
  return <I18n><LiveRegion><Shell /></LiveRegion></I18n>;
}
