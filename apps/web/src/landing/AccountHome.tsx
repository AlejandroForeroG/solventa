import { useIntl } from 'react-intl';
import { Icon, type IconName } from '../navigation/Icon';

const tiles: { href: string; icon: IconName; title: string; tone: string }[] = [
  { href: '/polizas', icon: 'policy', title: 'policies.open', tone: 'green' },
  { href: '/mis-siniestros', icon: 'claims', title: 'claims.customerCases', tone: 'blue' },
  { href: '/prestadores', icon: 'location', title: 'assistance.title', tone: 'amber' },
  { href: '/venta-asistida', icon: 'advisor', title: 'sale.title', tone: 'violet' },
  { href: '/privacidad', icon: 'privacy', title: 'privacy.open', tone: 'slate' },
];

export function AccountHome() {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <main className="account-home">
    <section className="account-hero" aria-labelledby="account-home-title">
      <div className="account-hero-copy">
        <h1 id="account-home-title">{t('landing.accountHeading')}</h1>
      </div>
      <a className="btn account-hero-cta" href="/cotizar"><Icon name="quote" size={18} />{t('home.quote')}<Icon name="forward" size={18} /></a>
    </section>
    <nav className="account-tiles" aria-label={t('home.shortcuts')}>
      {tiles.map(tile => <a key={tile.href} className={`account-tile account-tile-${tile.tone}`} href={tile.href}>
        <span className="account-tile-icon" aria-hidden="true"><Icon name={tile.icon} size={22} /></span>
        <span className="account-tile-text"><strong>{t(tile.title)}</strong></span>
        <Icon name="arrow" size={18} className="account-tile-arrow" />
      </a>)}
    </nav>
  </main>;
}
