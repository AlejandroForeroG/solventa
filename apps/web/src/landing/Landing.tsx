import { useIntl } from 'react-intl';
import { Icon } from '../navigation/Icon';
import { AccountHome } from './AccountHome';
import './landing.css';

export function Landing({ authenticated = false, sessionUnavailable, onRetry }: { authenticated?: boolean; sessionUnavailable: boolean; onRetry: () => void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `landing.${key}` });
  if (authenticated && !sessionUnavailable) return <AccountHome />;
  return <main className="landing">
    {sessionUnavailable && <div className="banner banner-error" role="alert">
      <p>{intl.formatMessage({ id: 'session.unavailable' })}</p>
      <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>{intl.formatMessage({ id: 'session.retry' })}</button>
    </div>}
    <section className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-intro">
        <p className="landing-badge"><Icon name="policy" size={16} />{t('product')}</p>
        <h1 id="landing-title">{t(authenticated ? 'accountHeading' : 'title')}</h1>
        <p className="landing-lede">{t(authenticated ? 'accountIntro' : 'intro')}</p>
        <div className="landing-actions">
          <a className="btn btn-primary" href={authenticated ? '/polizas' : '/cotizar'}>{authenticated ? intl.formatMessage({ id: 'policies.open' }) : t('start')} <Icon name="forward" size={18} /></a>
          <a className="landing-text-link" href={authenticated ? '/cotizar' : '#how-it-works'}>{authenticated ? intl.formatMessage({ id: 'navigation.quote' }) : t('how')}</a>
          {authenticated && <a className="landing-text-link" href="/mis-siniestros">{intl.formatMessage({ id: 'claims.customerCases' })}</a>}
          {authenticated && <a className="landing-text-link" href="/prestadores">{intl.formatMessage({ id: 'assistance.title' })}</a>}
        </div>
      </div>
      <aside className="landing-preparation" aria-labelledby="landing-prepare-title">
        <p className="section-label">{t('prepareLabel')}</p>
        <h2 id="landing-prepare-title">{t('prepareTitle')}</h2>
        <ul>
          <li><span className="landing-chip landing-chip-violet" aria-hidden="true"><Icon name="advisor" size={18} /></span>{t(authenticated ? 'identityDetails' : 'age')}</li>
          {authenticated && <li><span className="landing-chip landing-chip-amber" aria-hidden="true"><Icon name="location" size={18} /></span>{t('city')}</li>}
          <li><span className="landing-chip landing-chip-green" aria-hidden="true"><Icon name="coins" size={18} /></span>{t('amount')}</li>
          <li><span className="landing-chip landing-chip-blue" aria-hidden="true"><Icon name="calendar" size={18} /></span>{t('term')}</li>
        </ul>
        <p>{t('preliminary')}</p>
      </aside>
    </section>
    {!authenticated && <section className="landing-process" id="how-it-works" aria-labelledby="landing-how-title">
      <h2 id="landing-how-title">{t('how')}</h2>
      <div className="landing-process-grid">
        {([['estimate', 'calculator', 'green'], ['account', 'advisor', 'blue'], ['consent', 'privacy', 'violet']] as const).map(([topic, icon, tone], index) => <article key={topic} className="landing-step">
          <span className={`landing-chip landing-chip-${tone} landing-step-icon`} aria-hidden="true"><Icon name={icon} size={22} /><span className="landing-step-number">{index + 1}</span></span>
          <h3>{t(`${topic}Title`)}</h3>
          <p>{t(`${topic}Detail`)}</p>
        </article>)}
      </div>
    </section>}
    <footer className="landing-footer"><span>Solventa</span><p>{t('footer')}</p></footer>
  </main>;
}
