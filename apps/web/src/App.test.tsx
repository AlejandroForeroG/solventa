import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from './App';
import { readPurchaseDraft, savePurchaseDraft } from './offer/purchase-draft';
import { clearPolicyDocumentDestination, readPolicyDocumentDestination, savePolicyDocumentDestination } from './policies/document-destination';
import { readCustomerDestination, saveCustomerDestination } from './navigation/customer-destination';
import assistanceExamples from '../../../packages/contracts/examples/assistance-providers.json';
import auditExamples from '../../../packages/contracts/examples/underwriting-audit.json';
import claimsExamples from '../../../packages/contracts/examples/claims.json';
import reportsExamples from '../../../packages/contracts/examples/reports.json';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function serve(session: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = String(input);
    if (path === '/auth/session') return json({ authenticated: session === 200 }, session);
    if (path === '/api/v1/consents') return json({ items: [] });
    return json({ error: 'not_found' }, 404);
  });
}

beforeEach(() => window.history.replaceState(null, '', '/cotizar'));
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); });

describe('assistance directory route in the application', () => {
  it('shows contact details and hours without a provider selection control', async () => {
    window.history.replaceState(null, '', '/prestadores');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === '/auth/session') return json({ authenticated: true });
      if (input !== '/api/v1/assistance/providers/search') return json({ error: 'not_found' }, 404);
      return json({ ...assistanceExamples.empty, providers: [{
        id: 'demo-workshop', kind: 'workshop', name: 'Taller de prueba Bogotá', address: 'Calle de prueba 10',
        city: 'Bogotá', phone: '+570000000001', hours: 'Lun–vie 08:00–17:00',
      }] });
    });
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Ciudad o dirección' }), 'Bogotá');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    const result = within(await screen.findByRole('article'));
    expect(result.getByRole('heading', { name: 'Taller de prueba Bogotá' })).toBeVisible();
    expect(result.getByText(/Contacto de prueba.*\+570000000001/)).toBeVisible();
    expect(result.getByText(/Horario.*08:00–17:00/)).toBeVisible();
    expect(result.queryByRole('checkbox')).toBeNull();
    expect(result.queryByRole('button')).toBeNull();
  });
});

describe('audit route in the application', () => {
  it('requires sign-in and does not render the public calculator on the audit route', async () => {
    window.history.replaceState(null, '', '/auditoria'); serve(401); render(<App />);
    expect(await screen.findByRole('main')).toBeVisible();
    await screen.findByRole('heading', { name: 'Auditoría' });
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
  });
  it('unmounts protected content immediately while logout is pending or fails', async () => {
    window.history.replaceState(null, '', '/auditoria');
    let failLogout: () => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = String(input);
      if (path === '/auth/session') return json({ authenticated: true });
      if (path === '/auth/logout') return new Promise((_resolve, reject) => { failLogout = () => reject(new Error('synthetic outage')); });
      return json(auditExamples.page);
    });
    render(<App />); const user = userEvent.setup();
    const decisionLabel = `Decisión: ${auditExamples.detail.decision.quoteId ?? auditExamples.detail.decision.decisionId}`;
    await screen.findByRole('button', { name: new RegExp(`^${decisionLabel} · DEC-`) });
    await user.click(screen.getByRole('button', { name: 'Menú de mi cuenta' })); await user.click(screen.getByRole('menuitem', { name: 'Cerrar sesión' }));
    expect(screen.queryByRole('button', { name: new RegExp(`^${decisionLabel} · DEC-`) })).toBeNull();
    await act(async () => failLogout());
    expect(screen.queryByRole('button', { name: new RegExp(`^${decisionLabel} · DEC-`) })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos comprobar tu sesión.');
  });
});

describe('claims inbox route in the application', () => {
  it.each([
    { prefix: '/siniestros', audience: 'analyst', navigation: 'Consola operativa', label: 'Siniestros' },
    { prefix: '/mis-siniestros', audience: 'customer', navigation: 'Mi cuenta', label: 'Mis siniestros' }
  ])('keeps the case and its active navigation context on $prefix', async ({ prefix, audience, navigation, label }) => {
    const claimId = claimsExamples.ownedCases.items[0].claimId;
    window.history.replaceState(null, '', `${prefix}/${claimId}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === '/auth/session') return json({ authenticated: true });
      return json({ ...claimsExamples.caseFile, access: audience === 'analyst' ? 'assigned' : 'customer' });
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: `Expediente ${claimsExamples.caseFile.claimNumber}` })).toBeVisible();
    const sidebar = within(screen.getByRole('complementary', { name: navigation }));
    expect(sidebar.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    expect(sidebar.getByRole('link', { name: label })).toHaveAttribute('href', prefix);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`${claimId}`))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
    if (audience === 'customer') expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
  });

  it('requires sign-in and does not render the public calculator on the claims route', async () => {
    window.history.replaceState(null, '', '/siniestros'); serve(401); render(<App />);
    expect(await screen.findByRole('main')).toBeVisible();
    await screen.findByRole('heading', { name: 'Siniestros' });
    expect(screen.getAllByRole('link', { name: 'Ingresa a Solventa' })).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
  });
  it('shows the inbox to a signed-in user, links both consoles and unmounts it while logout is pending', async () => {
    window.history.replaceState(null, '', '/siniestros');
    let failLogout: () => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = String(input);
      if (path === '/auth/session') return json({ authenticated: true });
      if (path === '/auth/logout') return new Promise((_resolve, reject) => { failLogout = () => reject(new Error('synthetic outage')); });
      return json(claimsExamples.page);
    });
    render(<App />); const user = userEvent.setup();
    expect(await screen.findByRole('table', { name: 'Bandeja de siniestros' })).toBeVisible();
    expect(within(screen.getByRole('table')).getByRole('link', { name: claimsExamples.page.items[0].claimNumber }))
      .toHaveAttribute('href', `/siniestros/${claimsExamples.page.items[0].claimId}`);
    await waitFor(() => expect(screen.getByTestId('live-region')).toBeEmptyDOMElement());
    expect(within(screen.getByRole('complementary', { name: 'Consola operativa' })).getByRole('link', { name: 'Siniestros' })).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('complementary', { name: 'Consola operativa' })).getByRole('link', { name: 'Auditoría' })).toHaveAttribute('href', '/auditoria');
    await user.click(screen.getByRole('button', { name: 'Menú de mi cuenta' })); await user.click(screen.getByRole('menuitem', { name: 'Cerrar sesión' }));
    expect(screen.queryByRole('table')).toBeNull();
    await act(async () => failLogout());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos comprobar tu sesión.');
  });
});

describe('reports route in the application', () => {
  it('requires sign-in and does not render the public calculator on the reports route', async () => {
    window.history.replaceState(null, '', '/reportes'); serve(401); render(<App />);
    expect(await screen.findByRole('main')).toBeVisible();
    await screen.findByRole('heading', { name: 'Reportes' });
    expect(screen.getAllByRole('link', { name: 'Ingresa a Solventa' })).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
  });
  it('shows the reports to a signed-in user, links the other consoles and marks the current one', async () => {
    window.history.replaceState(null, '', '/reportes');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input) === '/auth/session' ? json({ authenticated: true }) : json(reportsExamples.page));
    render(<App />);
    expect(await screen.findByRole('table', { name: 'Reportes al regulador y la reaseguradora' })).toBeVisible();
    const nav = within(screen.getByRole('complementary', { name: 'Consola operativa' }));
    expect(nav.getByRole('link', { name: 'Reportes' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Siniestros' })).toHaveAttribute('href', '/siniestros');
    expect(screen.getAllByRole('link', { name: 'Reportes' }).some(link => link.getAttribute('href') === '/reportes')).toBe(true);
  });
});

describe('my policies route in the application', () => {
  const policy = { policyId: '10000000-0000-4000-8000-000000000001', product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP',
    effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveUntil: '2099-10-15T00:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' } };
  afterEach(clearPolicyDocumentDestination);
  it.each(['history', 'renewal', 'info'] as const)('keeps the %s action through an explicit sign-in click', async section => {
    window.history.replaceState(null, '', `/polizas#policy=${policy.policyId}&section=${section}`);
    serve(401); render(<App />);
    const links = await screen.findAllByRole('link', { name: 'Ingresa a Solventa' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { links[1].dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(readCustomerDestination()).toEqual({ kind: 'policy', policyId: policy.policyId, section });
    expect(screen.queryByText('Inicia sesión para abrir los documentos de la póliza seleccionada.')).toBeNull();
  });
  it('keeps a customer claim destination after failed sign-in and revalidates it for retry', async () => {
    const claimId = '30000000-0000-4000-8000-000000000001';
    saveCustomerDestination({ kind: 'claim', claimId });
    window.history.replaceState(null, '', '/?auth=failed');
    serve(401); render(<App />);
    await screen.findByRole('heading', { name: 'Mis siniestros' });
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
    const links = screen.getAllByRole('link', { name: 'Ingresa a Solventa' });
    act(() => { links[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(readCustomerDestination()).toEqual({ kind: 'claim', claimId });
  });
  it('allows both normal sign-in links after leaving document detail and losing the session', async () => {
    savePolicyDocumentDestination({ policyId: policy.policyId });
    window.history.replaceState(null, '', `/polizas#policy=${policy.policyId}&section=documents`);
    let expired = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === '/auth/session') return json({ authenticated: !expired }, expired ? 401 : 200);
      if (input === `/api/v1/policies/${policy.policyId}/detail`) return json({ ...policy,
        exclusions: [], conditionsVersion: 'academic-conditions-1', documents: [], payments: [],
        traceId: '50000000-0000-4000-8000-000000000001' });
      if (input === '/api/v1/policies/issued') return expired ? json({}, 401)
        : json({ policies: [policy], hasMore: false, traceId: '50000000-0000-4000-8000-000000000001' });
      return json({}, 404);
    });
    render(<App />);
    await screen.findByRole('tab', { name: 'Documentos', selected: true });
    const back = screen.getByRole('button', { name: /^Mis pólizas$/ });
    // The detail also fetches issued policies, so expire the session on navigation.
    back.addEventListener('click', () => { expired = true; }, { once: true });
    await userEvent.click(back);
    await screen.findByText('Tu sesión terminó. Inicia sesión para continuar.');
    expect(window.location.hash).toBe('');
    expect(readPolicyDocumentDestination()).toBeNull();
    expect(screen.queryByText('Inicia sesión para abrir los documentos de la póliza seleccionada.')).toBeNull();
    const links = screen.getAllByRole('link', { name: 'Ingresa a Solventa' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => { link.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
      expect(link).toHaveAttribute('href', '/auth/login');
    }
    expect(screen.queryByRole('link', { name: 'Iniciar sesión sin conservar la selección' })).toBeNull();
  });
  it('keeps the selected policy and a contextual retry after a failed sign-in', async () => {
    savePolicyDocumentDestination({ policyId: policy.policyId });
    window.history.replaceState(null, '', '/?auth=failed'); serve(401);
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Documentos de la póliza' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('No se completó el acceso.');
    expect(screen.getByText('POL-10000000')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
    const retry = await screen.findByRole('link', { name: 'Reintentar acceso' });
    expect(retry).toHaveAttribute('href', '/auth/login');
    await userEvent.click(retry);
    expect(readPolicyDocumentDestination()).toEqual({ policyId: policy.policyId });
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole('link', { name: 'Ir al inicio' }));
    expect(readPolicyDocumentDestination()).toBeNull();
  });
  it('does not silently retain an expired locator when retrying sign-in', async () => {
    savePolicyDocumentDestination({ policyId: policy.policyId });
    window.history.replaceState(null, '', '/?auth=failed'); serve(401); render(<App />);
    const retry = await screen.findByRole('link', { name: 'Reintentar acceso' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60 * 1000);
    await userEvent.click(retry);
    expect(readPolicyDocumentDestination()).toBeNull();
    expect(screen.getByText(/El navegador no pudo conservar la selección/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Iniciar sesión sin conservar la selección' })).toHaveAttribute('href', '/auth/login');
  });
  it('requires sign-in and does not render the public calculator on the policies route', async () => {
    window.history.replaceState(null, '', '/polizas'); serve(401); render(<App />);
    await screen.findByRole('heading', { name: 'Mis pólizas' });
    expect(await screen.findAllByRole('link', { name: 'Ingresa a Solventa' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Calcular estimación' })).toBeNull();
  });
  it('lists the policies of a signed-in user and links the section from the header', async () => {
    window.history.replaceState(null, '', '/polizas');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input) === '/auth/session' ? json({ authenticated: true })
      : json({ policies: [policy], hasMore: false, traceId: '50000000-0000-4000-8000-000000000001' }));
    render(<App />);
    expect(await screen.findByRole('button', { name: /^Ver detalle de Seguro de vida hipotecario/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Mis pólizas' })).toHaveAttribute('href', '/polizas');
  });
});

describe('privacy dashboard in the application', () => {
  it.each([
    { lostResponse: false, reconciliation: 'immediate' },
    { lostResponse: true, reconciliation: 'immediate' },
    { lostResponse: true, reconciliation: 'slow' },
    { lostResponse: true, reconciliation: 'failed' },
    { lostResponse: true, reconciliation: 'missing' }
  ])('returns a truthful consent state (lost response: $lostResponse, reconciliation: $reconciliation)', async ({ lostResponse, reconciliation }) => {
    const sources = [
      { code: 'open_finance_bancolombia', scope: 'income_obligations_12m', kind: 'open_finance' },
      { code: 'datacredito_experian', scope: 'payment_history_score', kind: 'credit_bureau' },
      { code: 'ruaf', scope: 'affiliation_regime', kind: 'open_data' },
      { code: 'registraduria', scope: 'identity_validation', kind: 'open_data' }
    ];
    const consent = { consentId: 'CNS-2026-00003', status: 'active', sources: sources.map(source => source.code), scopes: sources.map(source => source.scope), grantedAt: '2026-10-08T15:00:00Z', expiresAt: '2027-01-06T15:00:00Z', revokedAt: null as string | null, seal: 'a'.repeat(64) };
    let finishRead: ((response: Response) => void) | undefined;
    let recovered = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/auth/session') return json({ authenticated: true });
      if (path === '/api/v1/me/quotes') return json({ quoteId: 'COT-2026-08843', premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000, termMonths: 180, validUntil: '2026-11-05T15:47:00Z', basis: 'minimum_data', ruleVersion: 'provisional-1', traceId: '7f3c2a9e-1b4d-4c8a-a0d1-e2f3a4b5c6d7' }, 201);
      if (path === '/api/v1/consents/terms') return json({ purposeCode: 'risk_profiling', textVersion: 2, validityDays: 90, sources });
      if (path === '/api/v1/consents' && init?.method === 'POST') return json(consent, 201);
      if (path === '/api/v1/consents') {
        if (consent.status === 'revoked' && !recovered) {
          if (reconciliation === 'failed') return json({}, 503);
          if (reconciliation === 'missing') return json({ items: [], nextCursor: null });
          if (reconciliation === 'slow') return new Promise<Response>(resolve => { finishRead = resolve; });
        }
        return json({ items: [consent], nextCursor: null });
      }
      if (path.endsWith('/revoke')) {
        consent.status = 'revoked'; consent.revokedAt = '2026-10-14T15:00:00Z';
        if (lostResponse) throw new TypeError('response_lost_after_commit');
        return json(consent);
      }
      return json({}, 404);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText(/Nombre completo/);
    for (const [label, value] of [[/Nombre completo/, 'Cliente Sintetico Uno'], [/Documento/, '1000000001'], [/Fecha de nacimiento/, '1992-03-14'], [/Ciudad/, 'Bogotá'], [/Monto/, '320000000'], [/Plazo/, '180']] as const) await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a autorización de datos' }));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    await user.click(await screen.findByRole('button', { name: 'Ver panel de privacidad' }));
    await user.click(await screen.findByRole('button', { name: 'Revocar la autorización CNS-2026-00003' }));
    await user.click(screen.getByRole('button', { name: 'Sí, revocar' }));
    if (reconciliation === 'slow') {
      await waitFor(() => expect(finishRead).toBeDefined());
      const back = screen.getByRole('button', { name: 'Volver' });
      expect(back).toBeDisabled();
      await user.click(back);
      expect(screen.getByRole('heading', { name: 'Tus datos y quién los usa' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: /^Idioma:/ })); await user.click(screen.getByRole('menuitemradio', { name: 'English' }));
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      await act(async () => { finishRead?.(json({ items: [consent], nextCursor: null })); });
      recovered = true;
      await user.click(screen.getByRole('button', { name: /^Language:/ })); await user.click(screen.getByRole('menuitemradio', { name: 'Español' }));
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sí, revocar' })).toBeNull());
    if (reconciliation === 'failed' || reconciliation === 'missing') {
      await user.click(screen.getByRole('button', { name: 'Volver' }));
      expect(await screen.findByRole('heading', { name: 'Estado de autorización sin confirmar' })).toBeVisible();
      expect(screen.queryByText(/Vigente hasta/)).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Revocado' })).toBeNull();
      recovered = true;
      await user.click(screen.getByRole('button', { name: 'Ver panel de privacidad' }));
      await screen.findByText('Revocado', { selector: '.privacy .pill' });
    }
    expect(within(screen.getByRole('list')).getByText('Revocado')).toBeVisible();
    expect(screen.queryByText(/Sigue vigente/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    expect(await screen.findByRole('heading', { name: 'Revocado' })).toBeVisible();
    expect(screen.queryByText(/Vigente hasta/)).toBeNull();
    expect(screen.getByText(/ya no permite consultar las fuentes/)).toBeVisible();
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/revoke'))).toHaveLength(1);
  });

  it('is reachable from the header only with a session, and going back keeps what was typed', async () => {
    serve(200);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const open = await screen.findByRole('button', { name: 'Privacidad' });
    await user.type(screen.getByLabelText(/Nombre completo/), 'Cliente Sintetico Uno');

    await user.click(open);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tus datos y quién los usa' })).toHaveFocus();
    expect(await screen.findByText('Aún no has dado ninguna autorización.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Volver' }));
    await waitFor(() => expect(screen.getByLabelText(/Nombre completo/)).toBeVisible());
    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue('Cliente Sintetico Uno');
  });

  it('is not offered without a session', async () => {
    serve(401);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Calcular estimación' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Privacidad' })).toBeNull();
  });

  it('follows the language of the interface', async () => {
    serve(200);
    window.localStorage.setItem('solventa.locale', 'en-US');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Privacy' })).toBeInTheDocument();
  });
});

describe('purchase interrupted by a reload', () => {
  const acceptance = { acceptanceId: '20000000-0000-4000-8000-000000000002', offerId: '10000000-0000-4000-8000-000000000001', acceptedAt: '2026-10-15T00:01:00.000Z', traceId: '50000000-0000-4000-8000-000000000002' };

  it('reopens the signed-in purchase instead of the landing page, and logout forgets it', async () => {
    window.history.replaceState(null, '', '/');
    savePurchaseDraft({ quoteId: 'COT-2026-08843', acceptance, issue: null });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = String(input);
      if (path === '/auth/session') return json({ authenticated: true });
      if (path === '/auth/logout') return json({ error: 'unauthenticated' }, 401);
      if (path === '/api/v1/consents') return json({ items: [] });
      return json({ error: 'not_found' }, 404);
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === `/api/v1/policies/by-acceptance/${acceptance.acceptanceId}/policy`)).toBe(true));
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/offers'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Menú de mi cuenta' })); await user.click(screen.getByRole('menuitem', { name: 'Cerrar sesión' }));
    expect(readPurchaseDraft()).toBeNull();
  });
});

it('shows a not-found page for an unknown address instead of the landing', async () => {
  window.history.replaceState(null, '', '/ruta-que-no-existe');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })));
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'No encontramos esta página' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Ir al inicio' })).toHaveAttribute('href', '/');
  window.history.replaceState(null, '', '/');
});
