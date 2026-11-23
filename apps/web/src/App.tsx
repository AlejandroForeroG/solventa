import { AdvisorPortal } from './advisor/AdvisorActions';
import { PartnerPortal } from './partner-portal/PartnerPortal';
import { CustomerSalePortal } from './sale/CustomerSale';
import { AuditWorkspace } from './audit/AuditWorkspace';
import { ClaimCase, CustomerClaims } from './claims/ClaimCase';
import { uuid } from './claims/case-api';
import { ClaimsInbox } from './claims/ClaimsInbox';
import { ReportsWorkspace } from './reports/ReportsWorkspace';
import { PolicyPortal } from './policies/PolicyPortal';
import { ProviderSearch } from './assistance/ProviderSearch';
import { brandAssets } from '@solventa/assets/web';
import { ChannelShell } from './navigation/ChannelShell';
import { IconButton } from './navigation/IconAction';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { fetchSession, requestLogout } from './api/auth';
import type { SessionStatus } from './api/auth';
import { useIntl } from 'react-intl';
import { PrivacyPanel } from './consent/PrivacyPanel';
import { reconcileConsent, type Consent } from './consent/api';
import { I18n } from './i18n/I18n';
import { LiveRegion, useAnnounce } from './quote/Live';
import { QuoteFlow } from './quote/QuoteFlow';
import { clearPurchaseDraft, readPurchaseDraft } from './offer/purchase-draft';
import { Landing } from './landing/Landing';
import { PublicQuoteFlow } from './quote/PublicQuoteFlow';
import { clearEstimateDraft, readEstimateDraft, saveEstimateDraft } from './quote/estimate-draft';
import { invalidEstimateFields } from './quote/estimate-api';
import { clearCustomerDestination, customerDestination, customerDestinationPath, readCustomerDestination, saveCustomerDestination } from './navigation/customer-destination';

type Session = 'loading' | SessionStatus;

function Shell() {
  const intl = useIntl();
  const announce = useAnnounce();
  const [session, setSession] = useState<Session>('loading');
  const [busy, setBusy] = useState(false);
  const [estimateDraft, setEstimateDraft] = useState(readEstimateDraft);
  const [loginStorageFailed, setLoginStorageFailed] = useState(false);
  const [destination, setDestination] = useState(() => customerDestination()
    ?? (window.location.pathname === '/' ? readCustomerDestination() : null));
  const [destinationFailed, setDestinationFailed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [view, setView] = useState<'flow' | 'privacy'>('flow');
  const [consentUpdates, setConsentUpdates] = useState<Record<string, Consent>>({});
  const [uncertainConsents, setUncertainConsents] = useState<Record<string, boolean>>({});
  const updateConsents = useCallback((items: Consent[]) => {
    setConsentUpdates(current => ({ ...current, ...Object.fromEntries(items.map(item => [item.consentId, reconcileConsent(current[item.consentId], item)])) }));
    setUncertainConsents(current => ({ ...current, ...Object.fromEntries(items.map(item => [item.consentId, false])) }));
  }, []);
  const consentUncertain = useCallback((id: string) => setUncertainConsents(current => ({ ...current, [id]: true })), []);
  const sessionLost = useCallback(() => { setSessionExpired(true); setSession('anonymous'); }, []);
  const abandonDestination = useCallback(() => {
    clearCustomerDestination();
    setDestination(null);
    setDestinationFailed(false);
  }, []);
  const failed = new URLSearchParams(window.location.search).get('auth') === 'failed';
  const [purchaseInProgress] = useState(() => readPurchaseDraft() !== null);
  const isAudit = window.location.pathname === '/auditoria';
  const path = window.location.pathname;
  const restoringDestination = path === '/' && destination !== null && (session !== 'anonymous' || failed);
  const isCustomerClaims = path === '/mis-siniestros' || path.startsWith('/mis-siniestros/') || (restoringDestination && destination.kind === 'claim');
  const isClaims = path === '/siniestros' || path.startsWith('/siniestros/') || isCustomerClaims;
  const caseId = path.split('/')[2];
  const caseAudience = isCustomerClaims ? 'customer' : 'case';
  const isReports = path === '/reportes';
  const isProviders = window.location.pathname === '/prestadores';
  const isPolicies = window.location.pathname === '/polizas'
    || (restoringDestination && destination.kind === 'policy');
  const isAdvisor = window.location.pathname === '/asesor';
  const isSale = window.location.pathname === '/venta-asistida';
  const isPartnerPortal = window.location.pathname === '/socios';
  const isPrivacy = window.location.pathname === '/privacidad';
  const isConsole = isAdvisor || isSale || isPartnerPortal || isAudit || isClaims || isReports || isProviders || isPolicies || isPrivacy;
  const sectionTitle = isPrivacy ? 'privacy.open' : isAdvisor ? 'advisor.title' : isSale ? 'sale.title' : isPartnerPortal ? 'partnerPortal.title' : isPolicies ? 'policies.title' : isProviders ? 'assistance.title' : isClaims ? isCustomerClaims ? 'claims.customerCases' : 'claims.open' : isReports ? 'reports.open' : 'audit.open';
  const knownPath = path === '/' || path === '/cotizar' || isConsole || path.startsWith('/auth/');
  const isLanding = !isConsole && window.location.pathname !== '/cotizar' && !failed && !estimateDraft && !purchaseInProgress;
  async function load() {
    setSession('loading');
    setSession(await fetchSession());
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (window.location.pathname !== '/' && !customerDestination()) clearCustomerDestination();
  }, []);
  useEffect(() => { if (session === 'authenticated') clearEstimateDraft(); }, [session]);
  useEffect(() => {
    if (session === 'authenticated' && destination) {
      if (window.location.pathname === '/') window.location.replace(customerDestinationPath(destination));
      else if (customerDestination()) clearCustomerDestination();
    }
  }, [session, destination]);
  useEffect(() => {
    if (session === 'loading' || session === 'unavailable') {
      announce(intl.formatMessage({ id: session === 'loading' ? 'session.loading' : 'session.unavailable' }));
      return () => announce('');
    }
  }, [session, announce, intl]);
  async function logout() {
    clearCustomerDestination();
    setDestination(null);
    if (isPolicies && window.location.hash) window.history.replaceState(null, '', '/polizas');
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
  function prepareLogin(event: MouseEvent<HTMLAnchorElement>) {
    const current = customerDestination()
      ?? (window.location.pathname === '/' && failed ? readCustomerDestination() : null);
    if (!current && isConsole && destination) { event.preventDefault(); setDestinationFailed(true); return; }
    if (current && !saveCustomerDestination(current)) { event.preventDefault(); setDestinationFailed(true); return; }
    if (!current) clearCustomerDestination();
    if (estimateDraft && !invalidEstimateFields(estimateDraft).length && !saveEstimateDraft(estimateDraft)) { event.preventDefault(); setLoginStorageFailed(true); }
  }
  return <ChannelShell authenticated={session === 'authenticated'} canLogin={session === 'anonymous'} busy={busy} onLogout={() => void logout()} onLogin={prepareLogin}>
    {restoringDestination && session === 'authenticated'
      ? <main className="access-panel"><p role="status">{t('navigation.openingDestination')}</p></main>
      : isConsole ? (session === 'authenticated' && !busy
      ? isPrivacy ? <main className="content"><PrivacyPanel onConsentUncertain={consentUncertain} onConsentsChanged={updateConsents} onBack={() => window.location.assign('/polizas')} onSessionLost={sessionLost} /></main> : isAdvisor ? <AdvisorPortal onSessionLost={sessionLost} /> : isSale ? <CustomerSalePortal onSessionLost={sessionLost} /> : isPartnerPortal ? <PartnerPortal onSessionLost={sessionLost} /> : isPolicies ? <PolicyPortal destination={destination?.kind === 'policy' ? destination : undefined} onBackToList={abandonDestination} onSessionLost={sessionLost} /> : isProviders ? <ProviderSearch onSessionLost={sessionLost} /> : isClaims ? uuid(caseId) ? <ClaimCase key={path} claimId={caseId} audience={caseAudience} onSessionLost={sessionLost} /> : isCustomerClaims ? <CustomerClaims onSessionLost={sessionLost} /> : <ClaimsInbox onSessionLost={sessionLost} /> : isReports ? <ReportsWorkspace onSessionLost={sessionLost} /> : <AuditWorkspace onSessionLost={sessionLost} />
      : <main className="access-panel">
        <h1>{t(isPolicies && failed && destination?.kind === 'policy' && destination.section === 'documents' ? 'policies.documentAccessTitle' : sectionTitle)}</h1>
        {isPolicies && destination?.kind === 'policy' && <><p>{t(destination.section === 'documents' ? 'policies.documentSignIn' : 'navigation.destinationSignIn')}</p>
          {failed && <p className="mono">POL-{destination.policyId.slice(0, 8).toUpperCase()}</p>}</>}
        {failed && <p className="banner banner-error" role="alert">{t('session.failed')}</p>}
        {destinationFailed && <div role="alert"><p>{t('policies.destinationFailed')}</p><a href="/auth/login" onClick={clearCustomerDestination}>{t('policies.signInWithoutSelection')}</a></div>}
        {sessionExpired && <p role="alert">{t('navigation.expired')}</p>}
        {session === 'loading' || busy ? <p role="status">{t('session.loading')}</p>
          : session === 'unavailable' ? <>
            <p role="alert">{t('session.unavailable')}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>{t('session.retry')}</button>
          </> : <a className="btn btn-primary" href="/auth/login" onClick={prepareLogin}>{t(failed && isPolicies && destination ? 'policies.retrySignIn' : 'session.title')}</a>}
        {failed && isPolicies && destination && <p><a href="/" onClick={clearCustomerDestination}>{t('policies.backHome')}</a></p>}
      </main>)
      : !knownPath ? <main className="access-panel"><h1>{t('navigation.notFound')}</h1><a className="btn btn-primary" href="/">{t('navigation.goHome')}</a></main>
      : isLanding ? <Landing authenticated={session === 'authenticated'} sessionUnavailable={session === 'unavailable'} onRetry={() => void load()} /> : session === 'authenticated'
      ? <main className="content" aria-busy={busy}>
        <div className="channel-line"><img src={brandAssets.icon.green} alt="" width={28} height={28} /><span className="product">{t('brand.product')}</span>
          <IconButton className="btn-privacy" label={t('privacy.open')} icon="privacy" current={view === 'privacy'} onClick={() => setView('privacy')} />
        </div>
        <div hidden={view === 'privacy'}><QuoteFlow initialEstimate={estimateDraft} consentUpdates={consentUpdates} uncertainConsents={uncertainConsents} onOpenPrivacy={() => setView('privacy')} onSessionLost={sessionLost} /></div>
        {view === 'privacy' && <PrivacyPanel onConsentUncertain={consentUncertain} onConsentsChanged={updateConsents} onBack={() => setView('flow')} onSessionLost={sessionLost} />}
      </main>
      : <main className="content">
        {sessionExpired && <p className="banner banner-error" role="alert">{t('navigation.expired')}</p>}
        {failed && <p className="banner banner-error" role="alert">{t('session.failed')}</p>}
        {loginStorageFailed && <div className="banner banner-error" role="alert"><p>{t('estimate.storageFailed')}</p><a href="/auth/login" onClick={clearEstimateDraft}>{t('estimate.signInWithoutDraft')}</a></div>}
        {session === 'unavailable' && <div className="banner banner-error"><p>{t('session.unavailable')}</p><button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>{t('session.retry')}</button></div>}
        <PublicQuoteFlow initialValues={estimateDraft} onValuesChange={setEstimateDraft} />
      </main>}
  </ChannelShell>;
}

export default function App() {
  return <I18n><LiveRegion><Shell /></LiveRegion></I18n>;
}
