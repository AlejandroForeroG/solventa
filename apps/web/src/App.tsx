import { brandAssets } from '@solventa/assets/web';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { PrivacyPanel } from './consent/PrivacyPanel';
import { I18n, useLocale } from './i18n/I18n';
import { locales } from './i18n/messages';
import { LiveRegion, useAnnounce } from './quote/Live';
import { QuoteFlow } from './quote/QuoteFlow';

type Session = 'loading' | 'anonymous' | 'authenticated' | 'unavailable';

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
  const failed = new URLSearchParams(window.location.search).get('auth') === 'failed';
  async function load() {
    setSession('loading');
    try {
      const response = await fetch('/auth/session', { credentials: 'same-origin' });
      setSession(response.ok ? 'authenticated' : response.status === 401 ? 'anonymous' : 'unavailable');
    } catch { setSession('unavailable'); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (session === 'loading') announce(intl.formatMessage({ id: 'session.loading' }));
    if (session === 'unavailable') announce(intl.formatMessage({ id: 'session.unavailable' }));
  }, [session, announce, intl]);
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (response.status === 401) { setSession('anonymous'); return; }
      if (!response.ok) throw new Error('logout_failed');
      const { logoutUrl } = await response.json();
      window.location.assign(logoutUrl);
    } catch { setSession('unavailable'); }
    finally { setBusy(false); }
  }
  const t = (id: string) => intl.formatMessage({ id });
  return <div className="app-shell">
    <header className="channel-header">
      <img src={brandAssets.logo.green} alt="Solventa" width={174} />
      <div className="header-tools">
        <LocaleSwitch />
        {session === 'authenticated' && <button type="button" className="btn btn-secondary btn-small" onClick={() => void logout()} disabled={busy}>{busy ? t('session.loggingOut') : t('session.logout')}</button>}
      </div>
    </header>
    {session === 'authenticated'
      ? <main className="content" aria-busy={busy}>
        <div className="channel-line"><img src={brandAssets.icon.green} alt="" width={28} height={28} /><span className="product">{t('brand.product')}</span>
          <button type="button" className="btn btn-secondary btn-small btn-privacy" onClick={() => setView('privacy')} aria-current={view === 'privacy' ? 'page' : undefined}>{t('privacy.open')}</button>
        </div>
        <div hidden={view === 'privacy'}><QuoteFlow onOpenPrivacy={() => setView('privacy')} onSessionLost={() => setSession('anonymous')} /></div>
        {view === 'privacy' && <PrivacyPanel onBack={() => setView('flow')} onSessionLost={() => setSession('anonymous')} />}
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
