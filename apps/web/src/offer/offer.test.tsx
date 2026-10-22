import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { LiveRegion } from '../quote/Live';
import { createMortgageOffer, isMortgageOffer, type MortgageOffer } from './api';
import { OfferStep } from './OfferStep';

const offer: MortgageOffer = {
  offerId: '10000000-0000-4000-8000-000000000001', offerVersion: 1, quoteId: 'COT-2026-08843', product: 'vida_hipotecario',
  premium: '77760.0000', currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
  effectiveFrom: '2026-10-22T18:00:00.000Z', effectiveUntil: '2027-10-22T18:00:00.000Z', expiresAt: '2026-10-22T18:15:00.000Z',
  ruleVersion: 'academic-mortgage-1', synthetic: true, status: 'definitive', traceId: '50000000-0000-4000-8000-000000000001'
};

const wrap = (children: React.ReactNode) => <I18n initial="es-CO"><LiveRegion><main>{children}</main></LiveRegion></I18n>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('offer client', () => {
  it('accepts only the exact mortgage offer contract', () => {
    expect(isMortgageOffer(offer)).toBe(true);
    for (const changed of [
      { ...offer, premium: '77760' },
      { ...offer, status: 'accepted' },
      { ...offer, synthetic: false },
      { ...offer, coverage: { kind: 'mortgage_life', sumInsured: '-1.0000' } },
      { ...offer, traceId: 'not-a-trace' }
    ]) expect(isMortgageOffer(changed)).toBe(false);
  });

  it('sends an empty body with the same-origin session and idempotency key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(offer, 201));
    expect(await createMortgageOffer(offer.quoteId, 'offer-attempt-1')).toEqual({ kind: 'offer', offer });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/quotes/COT-2026-08843/offers');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('offer-attempt-1');
  });

  it('reuses the key after one session renewal and maps safe failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'unauthorized' }, 401))
      .mockResolvedValueOnce(json({ authenticated: true }))
      .mockResolvedValueOnce(json(offer));
    expect((await createMortgageOffer(offer.quoteId, 'same-key')).kind).toBe('offer');
    expect(fetchMock.mock.calls).toHaveLength(3);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('idempotency-key')).toBe('same-key');
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('idempotency-key')).toBe('same-key');
    fetchMock.mockReset().mockResolvedValue(json({ error: 'consent_required' }, 403));
    expect(await createMortgageOffer(offer.quoteId, 'key')).toEqual({ kind: 'consentRequired' });
    fetchMock.mockReset().mockResolvedValue(json({ ...offer, clientId: 'private' }));
    expect(await createMortgageOffer(offer.quoteId, 'key')).toEqual({ kind: 'unavailable' });
  });

});

describe('offer screen', () => {
  it('shows a definitive offer with exact decimal money and no degradation warning', async () => {
    const request = vi.fn().mockResolvedValue({ kind: 'offer', offer });
    const view = render(wrap(<OfferStep quoteId={offer.quoteId} request={request} onBack={vi.fn()} />));
    const heading = await screen.findByRole('heading', { name: 'Tu oferta de vida hipotecario' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('77.760 COP')).toBeVisible();
    expect(screen.getByText('320.000.000 COP')).toBeVisible();
    expect(screen.getByText('Definitiva')).toBeVisible();
    expect(screen.queryByText('Oferta preliminar')).toBeNull();
    expect(request.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('labels a degraded offer as preliminary and never enables acceptance', async () => {
    const preliminary = { ...offer, status: 'preliminary' as const };
    render(wrap(<OfferStep quoteId={offer.quoteId} request={vi.fn().mockResolvedValue({ kind: 'offer', offer: preliminary })} onBack={vi.fn()} />));
    const heading = await screen.findByRole('heading', { name: 'Tu oferta de vida hipotecario' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Oferta preliminar')).toBeVisible();
    expect(screen.getByText(/todavía no se puede aceptar/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Esperar oferta definitiva' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /aceptar/i })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('live-region')).toHaveTextContent(/Oferta preliminar calculada/));
  });

  it('retries an unavailable attempt with the same key and allows going back', async () => {
    const request = vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValueOnce({ kind: 'offer', offer });
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(wrap(<OfferStep quoteId={offer.quoteId} request={request} onBack={onBack} />));
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Definitiva')).toBeVisible();
    expect(request.mock.calls[0][1]).toBe(request.mock.calls[1][1]);
    await user.click(screen.getByRole('button', { name: 'Volver a la autorización' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
