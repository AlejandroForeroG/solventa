import { AdvisorPortal } from './advisor/AdvisorActions';
import { PartnerPortal } from './partner-portal/PartnerPortal';
import { AuditWorkspace } from './audit/AuditWorkspace';
import { ClaimsInbox } from './claims/ClaimsInbox';
import { PolicyPortal } from './policies/PolicyPortal';
import { ProviderSearch } from './assistance/ProviderSearch';
import { brandAssets } from '@solventa/assets/web';
import { ChannelShell } from './navigation/ChannelShell';
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
import { clearPolicyDocumentDestination, policyDocumentDestination, policyDocumentPath, readPolicyDocumentDestination, savePolicyDocumentDestination } from './policies/document-destination';

type Session = 'loading' | SessionStatus;

function Shell() {
  const intl = useIntl();
  const announce = useAnnounce();
  const [session, setSession] = useState<Session>('loading');
  const [busy, setBusy] = useState(false);
  const [estimateDraft, setEstimateDraft] = useState(readEstimateDraft);
  const [loginStorageFailed, setLoginStorageFailed] = useState(false);
  const [policyDestination, setPolicyDestination] = useState(() => policyDocumentDestination()
    ?? (window.location.pathname === '/' ? readPolicyDocumentDestination() : null));
  const [policyDestinationFailed, setPolicyDestinationFailed] = useState(false);
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
  const abandonPolicyDestination = useCallback(() => {
    clearPolicyDocumentDestination();
    setPolicyDestination(null);
    setPolicyDestinationFailed(false);
  }, []);
  const failed = new URLSearchParams(window.location.search).get('auth') === 'failed';
  const [purchaseInProgress] = useState(() => readPurchaseDraft() !== null);
  const isAudit = window.location.pathname === '/auditoria';
  const isClaims = window.location.pathname === '/siniestros';
  const isProviders = window.location.pathname === '/prestadores';
  const isPolicies = window.location.pathname === '/polizas'
    || (window.location.pathname === '/' && policyDestination !== null && (session !== 'anonymous' || failed));
  const isAdvisor = window.location.pathname === '/asesor';
  const isPartnerPortal = window.location.pathname === '/socios';
  const isConsole = isAdvisor || isPartnerPortal || isAudit || isClaims || isProviders || isPolicies;
  const sectionTitle = isAdvisor ? 'advisor.title' : isPartnerPortal ? 'partnerPortal.title' : isPolicies ? 'policies.title' : isProviders ? 'assistance.title' : isClaims ? 'claims.open' : 'audit.open';
  const isLanding = !isConsole && window.location.pathname !== '/cotizar' && !failed && !estimateDraft && !purchaseInProgress;
  async function load() {
    setSession('loading');
    setSession(await fetchSession());
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (window.location.pathname !== '/' && window.location.pathname !== '/polizas') clearPolicyDocumentDestination();
  }, []);
  useEffect(() => { if (session === 'authenticated') clearEstimateDraft(); }, [session]);
  useEffect(() => {
    if (session === 'authenticated' && policyDestination) {
      if (window.location.pathname === '/') window.location.replace(policyDocumentPath(policyDestination));
      else if (window.location.pathname === '/polizas') clearPolicyDocumentDestination();
    }
  }, [session, policyDestination]);
  useEffect(() => {
    if (session === 'loading' || session === 'unavailable') {
      announce(intl.formatMessage({ id: session === 'loading' ? 'session.loading' : 'session.unavailable' }));
      return () => announce('');
    }
  }, [session, announce, intl]);
  async function logout() {
    clearPolicyDocumentDestination();
    setPolicyDestination(null);
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
    const destination = policyDocumentDestination()
      ?? (window.location.pathname === '/' && failed ? readPolicyDocumentDestination() : null);
    if (!destination && isPolicies && policyDestination) { event.preventDefault(); setPolicyDestinationFailed(true); return; }
    if (destination && !savePolicyDocumentDestination(destination)) { event.preventDefault(); setPolicyDestinationFailed(true); return; }
    if (!destination) clearPolicyDocumentDestination();
    if (estimateDraft && !invalidEstimateFields(estimateDraft).length && !saveEstimateDraft(estimateDraft)) { event.preventDefault(); setLoginStorageFailed(true); }
  }
  return <ChannelShell authenticated={session === 'authenticated'} canLogin={session === 'anonymous'} busy={busy} onLogout={() => void logout()} onLogin={prepareLogin}>
    {isPolicies && session === 'authenticated' && window.location.pathname === '/'
      ? <main className="access-panel"><p role="status">{t('policies.openingDocuments')}</p></main>
      : isConsole ? (session === 'authenticated' && !busy
      ? isAdvisor ? <AdvisorPortal onSessionLost={sessionLost} /> : isPartnerPortal ? <PartnerPortal onSessionLost={sessionLost} /> : isPolicies ? <PolicyPortal documentDestination={policyDestination ?? policyDocumentDestination()} onBackToList={abandonPolicyDestination} onSessionLost={sessionLost} /> : isProviders ? <ProviderSearch onSessionLost={sessionLost} /> : isClaims ? <ClaimsInbox onSessionLost={sessionLost} /> : <AuditWorkspace onSessionLost={sessionLost} />
      : <main className="access-panel">
        <h1>{t(isPolicies && failed && policyDestination ? 'policies.documentAccessTitle' : sectionTitle)}</h1>
        {isPolicies && policyDestination && <><p>{t('policies.documentSignIn')}</p>
          {failed && <p className="mono">POL-{policyDestination.policyId.slice(0, 8).toUpperCase()}</p>}</>}
        {failed && <p className="banner banner-error" role="alert">{t('session.failed')}</p>}
        {policyDestinationFailed && <div role="alert"><p>{t('policies.destinationFailed')}</p><a href="/auth/login" onClick={clearPolicyDocumentDestination}>{t('policies.signInWithoutSelection')}</a></div>}
        {sessionExpired && <p role="alert">{t('navigation.expired')}</p>}
        {session === 'loading' || busy ? <p role="status">{t('session.loading')}</p>
          : session === 'unavailable' ? <>
            <p role="alert">{t('session.unavailable')}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void load()}>{t('session.retry')}</button>
          </> : <a className="btn btn-primary" href="/auth/login" onClick={prepareLogin}>{t(failed && isPolicies && policyDestination ? 'policies.retrySignIn' : 'session.title')}</a>}
        {failed && isPolicies && policyDestination && <p><a href="/" onClick={clearPolicyDocumentDestination}>{t('policies.backHome')}</a></p>}
      </main>)
      : isLanding ? <Landing authenticated={session === 'authenticated'} sessionUnavailable={session === 'unavailable'} onRetry={() => void load()} /> : session === 'authenticated'
      ? <main className="content" aria-busy={busy}>
        <div className="channel-line"><img src={brandAssets.icon.green} alt="" width={28} height={28} /><span className="product">{t('brand.product')}</span>
          <button type="button" className="btn btn-secondary btn-small btn-privacy" onClick={() => setView('privacy')} aria-current={view === 'privacy' ? 'page' : undefined}>{t('privacy.open')}</button>
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
