import { useIntl } from 'react-intl';
import './landing.css';

export function Landing({ sessionUnavailable, onRetry }: { sessionUnavailable: boolean; onRetry: () => void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `landing.${key}` });
  return <main className="landing">
    {sessionUnavailable && <div className="banner banner-error" role="alert">
      <p>{intl.formatMessage({ id: 'session.unavailable' })}</p>
      <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>{intl.formatMessage({ id: 'session.retry' })}</button>
    </div>}
    <section className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-intro">
        <p className="section-label">{t('product')}</p>
        <h1 id="landing-title">{t('title')}</h1>
        <p className="landing-lede">{t('intro')}</p>
        <div className="landing-actions">
          <a className="btn btn-primary" href="/cotizar">{t('start')} <span aria-hidden="true">→</span></a>
          <a className="landing-text-link" href="#how-it-works">{t('how')}</a>
        </div>
      </div>
      <aside className="landing-preparation" aria-labelledby="landing-prepare-title">
        <p className="section-label">{t('prepareLabel')}</p>
        <h2 id="landing-prepare-title">{t('prepareTitle')}</h2>
        <ul>
          <li>{t('age')}</li>
          <li>{t('amount')}</li>
          <li>{t('term')}</li>
        </ul>
        <p>{t('preliminary')}</p>
      </aside>
    </section>
    <section className="landing-process" id="how-it-works" aria-labelledby="landing-how-title">
      <h2 id="landing-how-title">{t('how')}</h2>
      <div className="landing-process-grid">
        {['estimate', 'account', 'consent'].map(topic => <article key={topic}>
          <h3>{t(`${topic}Title`)}</h3>
          <p>{t(`${topic}Detail`)}</p>
        </article>)}
      </div>
    </section>
    <footer className="landing-footer"><span>Solventa</span><p>{t('footer')}</p></footer>
  </main>;
}
