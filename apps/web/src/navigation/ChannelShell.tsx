import { useEffect, useRef, useState, type MouseEvent, type PropsWithChildren } from 'react';
import { useIntl } from 'react-intl';
import { brandAssets } from '@solventa/assets/web';
import { useLocale } from '../i18n/I18n';
import { locales } from '../i18n/messages';
import './channel-shell.css';

type IconName = 'home' | 'quote' | 'policy' | 'location' | 'claims' | 'audit' | 'advisor' | 'partner' | 'menu' | 'close' | 'exit' | 'arrow';
const paths: Record<IconName, string> = {
  home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  quote: 'M7 3h10v18H7zM10 7h4M10 11h4M10 15h1M13 15h1',
  policy: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6',
  location: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM10 10h4M12 8v4',
  claims: 'M5 5h14v16H5zM9 5V3h6v2M9 10h6M9 14h6M9 18h3',
  audit: 'M10 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM15 15l6 6M7 10l2 2 4-4',
  advisor: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2',
  partner: 'M3 21V7l9-4 9 4v14M3 11h18M7 15h2M15 15h2M10 21v-3h4v3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  exit: 'M10 4H4v16h6M14 8l4 4-4 4M8 12h12',
  arrow: 'm9 5 7 7-7 7',
};

function Icon({ name }: { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function LocaleSwitch() {
  const intl = useIntl();
  const { locale, setLocale } = useLocale();
  return <div className="locale-switch" role="group" aria-label={intl.formatMessage({ id: 'locale.group' })}>
    {locales.map(code => <button key={code} type="button" className="locale-btn" aria-pressed={locale === code} lang={code.slice(0, 2)}
      aria-label={intl.formatMessage({ id: 'locale.switchTo' }, { language: intl.formatMessage({ id: `locale.name.${code}` }) })}
      onClick={() => setLocale(code)}>{code === 'es-CO' ? 'ES' : 'EN'}</button>)}
  </div>;
}

const customerLinks: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'navigation.home', icon: 'home' },
  { href: '/polizas', label: 'policies.open', icon: 'policy' },
  { href: '/mis-siniestros', label: 'claims.customerCases', icon: 'claims' },
  { href: '/cotizar', label: 'navigation.quote', icon: 'quote' },
  { href: '/venta-asistida', label: 'sale.title', icon: 'advisor' },
  { href: '/prestadores', label: 'assistance.title', icon: 'location' },
];
const workspaceLinks: typeof customerLinks = [
  { href: '/siniestros', label: 'claims.open', icon: 'claims' },
  { href: '/reportes', label: 'reports.open', icon: 'audit' },
  { href: '/auditoria', label: 'audit.open', icon: 'audit' },
  { href: '/asesor', label: 'advisor.title', icon: 'advisor' },
  { href: '/socios', label: 'partnerPortal.title', icon: 'partner' },
];

export function ChannelShell({ authenticated, canLogin, busy, onLogout, onLogin, children }: PropsWithChildren<{
  authenticated: boolean; canLogin: boolean; busy: boolean; onLogout(): void; onLogin(event: MouseEvent<HTMLAnchorElement>): void;
}>) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const path = window.location.pathname;
  const matchesPath = (href: string) => path === href || (href !== '/' && path.startsWith(`${href}/`));
  const workspace = workspaceLinks.some(item => matchesPath(item.href));
  const area = t(workspace ? 'navigation.workspace' : 'navigation.account');
  const links = workspace ? workspaceLinks : customerLinks;
  const current = links.find(item => matchesPath(item.href));
  const dialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const stopBusyNavigation = (event: MouseEvent<HTMLAnchorElement>) => { if (busy) event.preventDefault(); };
  useEffect(() => {
    if (menuOpen) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [menuOpen]);

  const navigation = <>
    <a className="navigation-brand" href="/" aria-label={t('landing.home')} aria-disabled={busy || undefined} onClick={stopBusyNavigation}><img src={brandAssets.logo.white} width={150} alt="Solventa" /></a>
    <p className="navigation-section">{area}</p>
    <nav aria-label={t('navigation.primary')} className="navigation-links">
      {links.map(item => <a key={item.href} href={item.href} aria-current={matchesPath(item.href) ? 'page' : undefined} aria-disabled={busy || undefined} onClick={stopBusyNavigation}>
        <Icon name={item.icon} /><span>{t(item.label)}</span>
      </a>)}
    </nav>
    <div className="navigation-footer">
      <a href={workspace ? '/polizas' : '/siniestros'} className="navigation-context" aria-disabled={busy || undefined} onClick={stopBusyNavigation}><Icon name={workspace ? 'policy' : 'partner'} /><span>{t(workspace ? 'navigation.backToAccount' : 'navigation.workspace')}</span><Icon name="arrow" /></a>
      <button type="button" className="navigation-logout" onClick={onLogout} disabled={busy}><Icon name="exit" /><span>{t(busy ? 'session.loggingOut' : 'session.logout')}</span></button>
    </div>
  </>;

  return <div className={`channel-layout${authenticated ? ' channel-layout-signed-in' : ''}`}>
    <a href="#channel-content" className="skip-link">{t('navigation.skip')}</a>
    {authenticated && <aside className="channel-sidebar" aria-label={workspace ? t('claims.console') : area}>{navigation}</aside>}
    <div className="channel-workspace">
      <header className="channel-topbar">
        {authenticated && <button type="button" className="navigation-menu-trigger" aria-label={t('navigation.open')} aria-expanded={menuOpen} aria-controls="channel-navigation-dialog" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>}
        <a href="/" className={`channel-topbar-brand${authenticated ? ' channel-topbar-brand-mobile' : ''}`} aria-label={t('landing.home')} aria-disabled={busy || undefined} onClick={stopBusyNavigation}><img src={brandAssets.logo.green} alt="Solventa" width={150} /></a>
        {authenticated && <div className="channel-breadcrumb"><span>{area}</span><span aria-hidden="true">/</span><span>{t(current?.label ?? 'navigation.home')}</span></div>}
        <div className="channel-topbar-tools"><LocaleSwitch />
          {canLogin && <a className="btn btn-primary btn-small" href="/auth/login" onClick={onLogin}>{t('session.title')}</a>}
        </div>
      </header>
      <div id="channel-content" tabIndex={-1} className="channel-content">{children}</div>
    </div>
    {authenticated && <dialog id="channel-navigation-dialog" ref={dialog} className="navigation-dialog" aria-label={t('navigation.menu')} aria-modal="true"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href]:not([aria-disabled="true"]), button:not([disabled])');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClose={() => setMenuOpen(false)} onCancel={() => setMenuOpen(false)} onClick={event => { if (event.target === event.currentTarget) setMenuOpen(false); }}>
      <div className="navigation-dialog-panel"><button type="button" className="navigation-menu-close" aria-label={t('navigation.close')} onClick={() => setMenuOpen(false)}><Icon name="close" /></button>{navigation}</div>
    </dialog>}
  </div>;
}
