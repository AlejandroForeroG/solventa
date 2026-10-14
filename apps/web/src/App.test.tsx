import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from './App';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function serve(session: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = String(input);
    if (path === '/auth/session') return json({ authenticated: session === 200 }, session);
    if (path === '/api/v1/consents') return json({ items: [] });
    return json({ error: 'not_found' }, 404);
  });
}

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe('privacy dashboard in the application', () => {
  it.each([false, true])('keeps a revoked consent revoked when returning to the quote (lost response: %s)', async lostResponse => {
    const sources = [
      { code: 'open_finance_bancolombia', scope: 'income_obligations_12m', kind: 'open_finance' },
      { code: 'datacredito_experian', scope: 'payment_history_score', kind: 'credit_bureau' },
      { code: 'ruaf', scope: 'affiliation_regime', kind: 'open_data' },
      { code: 'registraduria', scope: 'identity_validation', kind: 'open_data' }
    ];
    const consent = { consentId: 'CNS-2026-00003', status: 'active', sources: sources.map(source => source.code), scopes: sources.map(source => source.scope), grantedAt: '2026-10-08T15:00:00Z', expiresAt: '2027-01-06T15:00:00Z', revokedAt: null as string | null, seal: 'a'.repeat(64) };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/auth/session') return json({ authenticated: true });
      if (path === '/api/v1/me/quotes') return json({ quoteId: 'COT-2026-08843', premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000, termMonths: 180, validUntil: '2026-11-05T15:47:00Z', basis: 'minimum_data', ruleVersion: 'provisional-1', traceId: '7f3c2a9e-1b4d-4c8a-a0d1-e2f3a4b5c6d7' }, 201);
      if (path === '/api/v1/consents/terms') return json({ purposeCode: 'risk_profiling', textVersion: 2, validityDays: 90, sources });
      if (path === '/api/v1/consents' && init?.method === 'POST') return json(consent, 201);
      if (path === '/api/v1/consents') return json({ items: [consent], nextCursor: null });
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
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sí, revocar' })).toBeNull());
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
    expect(await screen.findByRole('link', { name: 'Continuar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Panel de privacidad' })).toBeNull();
  });

  it('follows the language of the interface', async () => {
    serve(200);
    window.localStorage.setItem('solventa.locale', 'en-US');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Privacy dashboard' })).toBeInTheDocument();
  });
});
