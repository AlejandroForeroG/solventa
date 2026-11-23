import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import '@solventa/assets/fonts/web.css';
import './index.css';
import './policies/policies.css';
import './landing/landing.css';
import { I18n } from './i18n/I18n';
import { ChargeConfirmed, PolicyDocument, PolicyIssued } from './offer/OfferViews';
import { AccountHome } from './landing/AccountHome';
import type { Policy } from './offer/api';

const policy: Policy = {
  policyId: '10000000-0000-4000-8000-000000000001', offerId: '20000000-0000-4000-8000-000000000002', status: 'issued', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-11-22T05:00:00.000Z', effectiveUntil: '2027-11-22T05:00:00.000Z',
  document: JSON.stringify({ coverage: { kind: 'mortgage_life', sumInsured: '250000000.0000', currency: 'COP' }, premium: '86400.0000', offerVersion: 1, policyId: '10000000-0000-4000-8000-000000000001', providerMode: 'mock' }),
  documentHash: 'a3f1c29e5b7d4086a3f1c29e5b7d4086a3f1c29e5b7d4086a3f1c29e5b7d4086', payment: { status: 'confirmed', reference: 'PAY-SIM-8842-1190-AA71' }, replayed: false,
  traceId: '30000000-0000-4000-8000-000000000003',
};
const view = new URLSearchParams(window.location.search).get('view');
const noop = () => {};
const heading = createRef<HTMLHeadingElement>();
const challenge = { challengeId: 'c1', expiresAt: new Date(Date.now() + 280000).toISOString(), demoCode: '482913' };
createRoot(document.getElementById('root')!).render(<I18n initial="es-CO"><div className="channel-area-customer"><div className="channel-content" style={{ padding: 16 }}><div className="content">
  {view === 'issued' && <PolicyIssued heading={heading} policy={policy} />}
  {view === 'review' && <PolicyDocument heading={heading} policy={policy} stage="review" checked={false} documentChanged={false} challenge={null} code="" busy={false} error={null} onCode={noop} onCheck={noop} onBegin={noop} onCancel={noop} onConfirm={noop} onContinue={noop} />}
  {view === 'sign' && <PolicyDocument heading={heading} policy={policy} stage="sign" checked documentChanged={false} challenge={challenge} code="482913" busy={false} error={null} onCode={noop} onCheck={noop} onBegin={noop} onCancel={noop} onConfirm={noop} onContinue={noop} />}
  {view === 'charged' && <ChargeConfirmed heading={heading} policy={policy} idempotencyKey="40000000-0000-4000-8000-000000000004" onContinue={noop} />}
  {view === 'home' && <AccountHome />}
</div></div></div></I18n>);
