import { AdvisorPortal } from './advisor/AdvisorActions';
import { PartnerPortal } from './partner-portal/PartnerPortal';
import { AuditWorkspace } from './audit/AuditWorkspace';
import { ClaimCase, CustomerClaims } from './claims/ClaimCase';
import { uuid } from './claims/case-api';
import { ClaimsInbox } from './claims/ClaimsInbox';
import { ReportsWorkspace } from './reports/ReportsWorkspace';
import { PolicyPortal } from './policies/PolicyPortal';
import { ProviderSearch } from './assistance/ProviderSearch';
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
import { clearPurchaseDraft, readPurchaseDraft } from './offer/purchase-draft';
import { Landing } from './landing/Landing';
import { PublicQuoteFlow } from './quote/PublicQuoteFlow';
import { clearEstimateDraft, readEstimateDraft, saveEstimateDraft } from './quote/estimate-draft';
import { invalidEstimateFields } from './quote/estimate-api';

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
  const [estimateDraft, setEstimateDraft] = useState(readEstimateDraft);
  const [loginStorageFailed, setLoginStorageFailed] = useState(false);
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
  const [purchaseInProgress] = useState(() => readPurchaseDraft() !== null);
  const isAudit = window.location.pathname === '/auditoria';
  const path = window.location.pathname;
  const isCustomerClaims = path === '/mis-siniestros' || path.startsWith('/mis-siniestros/');
  const isClaims = path === '/siniestros' || path.startsWith('/siniestros/') || isCustomerClaims;
  const caseId = path.split('/')[2];
  const caseAudience = isCustomerClaims ? 'customer' : 'case';
  const isReports = path === '/reportes';
  const isProviders = window.location.pathname === '/prestadores';
  const isPolicies = window.location.pathname === '/polizas';
  const isAdvisor = window.location.pathname === '/asesor';
  const isPartnerPortal = window.location.pathname === '/socios';
  const isConsole = isAdvisor || isPartnerPortal || isAudit || isClaims || isReports || isProviders || isPolicies;
  const sectionTitle = isAdvisor ? 'advisor.title' : isPartnerPortal ? 'partnerPortal.title' : isPolicies ? 'policies.title' : isProviders ? 'assistance.title' : isClaims ? isCustomerClaims ? 'claims.customerCases' : 'claims.open' : isReports ? 'reports.open' : 'audit.open';
  const isLanding = !isConsole && window.location.pathname !== '/cotizar' && !failed && !estimateDraft && !purchaseInProgress;
  async function load() {
    setSession('loading');
    setSession(await fetchSession());
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (session === 'authenticated') clearEstimateDraft(); }, [session]);
  useEffect(() => {
    if (session === 'loading') announce(intl.formatMessage({ id: 'session.loading' }));
    if (session === 'unavailable') announce(intl.formatMessage({ id: 'session.unavailable' }));
  }, [session, announce, intl]);
  async function logout() {
    clearEstimateDraft();
    clearPurchaseDraft();
    setEstimateDraft(null);
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
        {session === 'anonymous' && <a className="btn btn-secondary btn-small" href="/auth/login" onClick={event => {
          if (estimateDraft && !invalidEstimateFields(estimateDraft).length && !saveEstimateDraft(estimateDraft)) { event.preventDefault(); setLoginStorageFailed(true); }
        }}>{t('session.title')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/polizas">{t('policies.open')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/mis-siniestros">{t('claims.customerCases')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/siniestros">{t('claims.open')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/reportes">{t('reports.open')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/prestadores">{t('assistance.title')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/asesor">{t('advisor.title')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/socios">{t('partnerPortal.title')}</a>}
        {session === 'authenticated' && <a className="btn btn-secondary btn-small" href="/auditoria">{t('audit.open')}</a>}
        {session === 'authenticated' && <button type="button" className="btn btn-secondary btn-small" onClick={() => void logout()} disabled={busy}>{busy ? t('session.loggingOut') : t('session.logout')}</button>}
      </div>
    </header>
    {isConsole ? (session === 'authenticated' && !busy
      ? isAdvisor ? <AdvisorPortal onSessionLost={sessionLost} /> : isPartnerPortal ? <PartnerPortal onSessionLost={sessionLost} /> : isPolicies ? <PolicyPortal onSessionLost={sessionLost} /> : isProviders ? <ProviderSearch onSessionLost={sessionLost} /> : isClaims ? uuid(caseId) ? <ClaimCase key={path} claimId={caseId} audience={caseAudience} onSessionLost={sessionLost} /> : isCustomerClaims ? <CustomerClaims onSessionLost={sessionLost} /> : <ClaimsInbox onSessionLost={sessionLost} /> : isReports ? <ReportsWorkspace onSessionLost={sessionLost} /> : <AuditWorkspace onSessionLost={sessionLost} />
      : <main className="access-panel">
        <h1>{t(sectionTitle)}</h1>
        {session === 'loading' || busy ? <p role="status">{t('session.loading')}</p>
          : session === 'unavailable' ? <>
            <p role="alert">{t('session.unavailable')}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>{t('session.retry')}</button>
          </> : <a className="btn btn-primary" href="/auth/login">{t('session.title')}</a>}
      </main>)
      : isLanding ? <Landing sessionUnavailable={session === 'unavailable'} onRetry={() => void load()} /> : session === 'authenticated'
      ? <main className="content" aria-busy={busy}>
        <div className="channel-line"><img src={brandAssets.icon.green} alt="" width={28} height={28} /><span className="product">{t('brand.product')}</span>
          <button type="button" className="btn btn-secondary btn-small btn-privacy" onClick={() => setView('privacy')} aria-current={view === 'privacy' ? 'page' : undefined}>{t('privacy.open')}</button>
        </div>
        <div hidden={view === 'privacy'}><QuoteFlow initialEstimate={estimateDraft} consentUpdates={consentUpdates} uncertainConsents={uncertainConsents} onOpenPrivacy={() => setView('privacy')} onSessionLost={sessionLost} /></div>
        {view === 'privacy' && <PrivacyPanel onConsentUncertain={consentUncertain} onConsentsChanged={updateConsents} onBack={() => setView('flow')} onSessionLost={sessionLost} />}
      </main>
      : <main className="content">
        {failed && <p className="banner banner-error" role="alert">{t('session.failed')}</p>}
        {loginStorageFailed && <div className="banner banner-error" role="alert"><p>{t('estimate.storageFailed')}</p><a href="/auth/login" onClick={clearEstimateDraft}>{t('estimate.signInWithoutDraft')}</a></div>}
        {session === 'unavailable' && <div className="banner banner-error"><p>{t('session.unavailable')}</p><button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>{t('session.retry')}</button></div>}
        <PublicQuoteFlow initialValues={estimateDraft} onValuesChange={setEstimateDraft} />
      </main>}
  </div>;
}

export default function App() {
  return <I18n><LiveRegion><Shell /></LiveRegion></I18n>;
}
