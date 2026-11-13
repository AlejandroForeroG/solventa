import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from './App';
import { readPurchaseDraft, savePurchaseDraft } from './offer/purchase-draft';
import assistanceExamples from '../../../packages/contracts/examples/assistance-providers.json';
import auditExamples from '../../../packages/contracts/examples/underwriting-audit.json';
import claimsExamples from '../../../packages/contracts/examples/claims.json';

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
  it('shows contact details and hours, and offers the request without a provider selection control', async () => {
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
    // The only action is the request itself; nothing to tick or choose among providers.
    expect(result.getAllByRole('button').map(button => button.textContent)).toEqual(['Solicitar asistencia']);
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
    await screen.findByRole('button', { name: auditExamples.detail.decision.decisionId });
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(screen.queryByRole('button', { name: auditExamples.detail.decision.decisionId })).toBeNull();
    await act(async () => failLogout());
    expect(screen.queryByRole('button', { name: auditExamples.detail.decision.decisionId })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos comprobar tu sesión.');
  });
});

describe('claims inbox route in the application', () => {
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
    expect(within(screen.getByRole('complementary', { name: 'Consola operativa' })).getByRole('link', { name: 'Siniestros' })).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('complementary', { name: 'Consola operativa' })).getByRole('link', { name: 'Auditoría' })).toHaveAttribute('href', '/auditoria');
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(screen.queryByRole('table')).toBeNull();
    await act(async () => failLogout());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos comprobar tu sesión.');
  });
});

describe('my policies route in the application', () => {
  const policy = { policyId: '10000000-0000-4000-8000-000000000001', product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP',
    effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveUntil: '2099-10-15T00:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' } };
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
    expect(await screen.findByRole('button', { name: /^Ver detalle de Vida hipotecario/ })).toBeVisible();
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
      await user.click(screen.getByRole('button', { name: /Cambiar la interfaz a inglés/ }));
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      await act(async () => { finishRead?.(json({ items: [consent], nextCursor: null })); });
      recovered = true;
      await user.click(screen.getByRole('button', { name: /Switch the interface to Spanish/ }));
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
    const open = await screen.findByRole('button', { name: 'Panel de privacidad' });
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
    expect(screen.queryByRole('button', { name: 'Panel de privacidad' })).toBeNull();
  });

  it('follows the language of the interface', async () => {
    serve(200);
    window.localStorage.setItem('solventa.locale', 'en-US');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Privacy dashboard' })).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(readPurchaseDraft()).toBeNull();
  });
});
