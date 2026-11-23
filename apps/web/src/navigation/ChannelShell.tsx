import { useEffect, useRef, useState, type MouseEvent, type PropsWithChildren } from 'react';
import { useIntl } from 'react-intl';
import { brandAssets } from '@solventa/assets/web';
import { useLocale } from '../i18n/I18n';
import { locales } from '../i18n/messages';
import { Icon, type IconName } from './Icon';
import { MenuButton } from './MenuButton';
import './channel-shell.css';

export function LocaleSwitch() {
  const intl = useIntl();
  const { locale, setLocale } = useLocale();
  const name = (code: string) => intl.formatMessage({ id: `locale.short.${code}` });
  return <MenuButton className="locale-menu" label={intl.formatMessage({ id: 'locale.menu' }, { language: name(locale) })}
    content={<><Icon name="globe" size={18} /><span className="locale-code">{locale === 'es-CO' ? 'ES' : 'EN'}</span><Icon name="chevron" size={14} /></>}
    entries={locales.map(code => ({ kind: 'radio' as const, label: name(code), lang: code.slice(0, 2), checked: locale === code, onSelect: () => setLocale(code) }))} />;
}

const customerLinks: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'navigation.home', icon: 'home' },
  { href: '/polizas', label: 'policies.open', icon: 'policy' },
  { href: '/mis-siniestros', label: 'claims.customerCases', icon: 'claims' },
  { href: '/prestadores', label: 'assistance.title', icon: 'location' },
  { href: '/venta-asistida', label: 'sale.title', icon: 'advisor' },
  { href: '/privacidad', label: 'privacy.open', icon: 'privacy' },
];
const workspaceLinks: typeof customerLinks = [
  { href: '/siniestros', label: 'claims.open', icon: 'claims' },
  { href: '/reportes', label: 'reports.open', icon: 'reports' },
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
  const current = links.find(item => matchesPath(item.href)) ?? (matchesPath('/cotizar') ? { label: 'navigation.quote' } : undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const stopBusyNavigation = (event: MouseEvent<HTMLAnchorElement>) => { if (busy) event.preventDefault(); };
  useEffect(() => {
    if (menuOpen) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [menuOpen]);

  const navigation = <>
    <a className="navigation-brand" href="/" aria-label={t('landing.home')} aria-disabled={busy || undefined} onClick={stopBusyNavigation}><img src={brandAssets.logo.white} width={150} alt="Solventa" /></a>
    {!workspace && <a className="btn navigation-cta" href="/cotizar" aria-current={matchesPath('/cotizar') ? 'page' : undefined} aria-disabled={busy || undefined} onClick={stopBusyNavigation}><Icon name="quote" size={18} /><span>{t('navigation.quote')}</span></a>}
    <p className="navigation-section">{area}</p>
    <nav aria-label={t('navigation.primary')} className="navigation-links">
      {links.map(item => <a key={item.href} href={item.href} aria-current={matchesPath(item.href) ? 'page' : undefined} aria-disabled={busy || undefined} onClick={stopBusyNavigation}>
        <Icon name={item.icon} /><span>{t(item.label)}</span>
      </a>)}
    </nav>
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
          {authenticated && <MenuButton className="account-menu" label={t('session.accountMenu')}
            content={<><span className="account-avatar" aria-hidden="true"><Icon name="advisor" size={18} /></span><span className="account-label">{t('navigation.account')}</span><Icon name="chevron" size={14} /></>}
            entries={[
              { kind: 'link', label: t('privacy.open'), href: '/privacidad', icon: <Icon name="privacy" size={18} />, disabled: busy },
              { kind: 'link', label: t(workspace ? 'navigation.backToAccount' : 'navigation.workspace'), href: workspace ? '/polizas' : '/siniestros', icon: <Icon name={workspace ? 'policy' : 'workspace'} size={18} />, disabled: busy },
              { kind: 'action', label: t(busy ? 'session.loggingOut' : 'session.logout'), onSelect: onLogout, icon: <Icon name="exit" size={18} />, disabled: busy },
            ]} />}
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
