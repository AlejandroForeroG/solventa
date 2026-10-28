import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from './App';
import { readPurchaseDraft, savePurchaseDraft } from './offer/purchase-draft';

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
