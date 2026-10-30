import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { I18n, useLocale } from '../i18n/I18n';
import type { Locale } from '../i18n/messages';
import { LiveRegion } from '../quote/Live';
import type { Quote } from '../quote/api';
import { ConsentGranted } from '../consent/ConsentOutcome';
import { QuoteFlow } from '../quote/QuoteFlow';
import type { Consent } from '../consent/api';
import { acceptOffer, createOffer, issuePolicy, policyForAcceptance, type Acceptance, type FinancialApi, type FinancialOutcome, type Offer, type Policy } from './api';
import { OfferJourney } from './OfferJourney';
import { readPurchaseDraft, savePurchaseDraft } from './purchase-draft';

const quote: Quote = { quoteId: 'COT-2026-08843', premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000, termMonths: 180, validUntil: '2026-11-05T10:47:00-05:00', basis: 'minimum_data', ruleVersion: 'provisional-1', traceId: '7f3c2a9e-1b4d-4c8a-a0d1-e2f3a4b5c6d7' };
const offer: Offer = { offerId: '10000000-0000-4000-8000-000000000001', offerVersion: 1, quoteId: quote.quoteId, premium: '77760.0000', currency: 'COP', sumInsured: '320000000.0000', effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveUntil: '2027-10-15T00:00:00.000Z', expiresAt: '2026-10-15T00:15:00.000Z', ruleVersion: 'academic-mortgage-1', traceId: '50000000-0000-4000-8000-000000000001' };
const acceptance: Acceptance = { acceptanceId: '20000000-0000-4000-8000-000000000002', offerId: offer.offerId, acceptedAt: '2026-10-15T00:01:00.000Z', traceId: '50000000-0000-4000-8000-000000000002' };
const document = '{"currency":"COP","offerId":"10000000-0000-4000-8000-000000000001","premium":"77760.0000","providerMode":"mock","synthetic":true}';
const pending: Policy = { policyId: '30000000-0000-4000-8000-000000000003', offerId: offer.offerId, status: 'pending', premium: '77760.0000', currency: 'COP', effectiveFrom: offer.effectiveFrom, effectiveUntil: offer.effectiveUntil, document, documentHash: 'a'.repeat(64), payment: null, replayed: false, traceId: '50000000-0000-4000-8000-000000000003' };
const receipt = 'MOCK-60000000-0000-4000-8000-000000000006';
const charged: Policy = { ...pending, status: 'charged', payment: { status: 'confirmed', reference: receipt } };
const issued: Policy = { ...pending, status: 'issued', payment: { status: 'confirmed', reference: receipt }, traceId: '50000000-0000-4000-8000-000000000004' };
const challenge = { challengeId: '80000000-0000-4000-8000-000000000008', expiresAt: '2099-10-15T00:05:00.000Z', demoCode: '123456' };
const ok = <T,>(value: T): FinancialOutcome<T> => ({ kind: 'ok', value });
const fast = { firstDelayMs: 1, maxDelayMs: 1, budgetMs: 50 };

function stubs(over: Partial<Record<keyof FinancialApi, Mock>> = {}): Record<keyof FinancialApi, Mock> {
  return {
    createOffer: vi.fn().mockResolvedValue(ok(offer)),
    acceptOffer: vi.fn().mockResolvedValue(ok(acceptance)),
    policyForAcceptance: vi.fn().mockResolvedValueOnce({ kind: 'notFound' }).mockResolvedValueOnce(ok(pending)).mockResolvedValue(ok(charged)),
    beginSignatureChallenge: vi.fn().mockResolvedValue(ok(challenge)),
    cancelSignatureChallenge: vi.fn().mockResolvedValue(ok(pending)),
    issuePolicy: vi.fn().mockResolvedValue(ok(issued)),
    chargePolicy: vi.fn().mockResolvedValue(ok(charged)),
    ...over
  };
}
const live = () => screen.getByTestId('live-region');
const wrap = (locale: Locale, children: ReactNode) => <I18n initial={locale}><LiveRegion><main>{children}</main></LiveRegion></I18n>;

function journey(api = stubs(), locale: Locale = 'es-CO', strict = false) {
  const handlers = { onRequote: vi.fn(), onConsentRequired: vi.fn(), onBack: vi.fn(), onSessionLost: vi.fn() };
  const element = wrap(locale, <OfferJourney quote={quote} api={api as never} poll={fast} {...handlers} />);
  const view = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return { api, user: userEvent.setup(), ...handlers, ...view };
}

async function signFromReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continuar al cobro' }));
  await user.click(await screen.findByRole('button', { name: 'Continuar a la firma' }));
  await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
  await user.type(await screen.findByLabelText('Código de autenticación'), challenge.demoCode);
  await user.click(screen.getByRole('button', { name: 'Firmar póliza' }));
}

afterEach(() => { vi.restoreAllMocks(); });

describe('definitive offer journey', () => {
  it('backs off unavailable reads and stops at the budget without repeating acceptance or declaring issuance', async () => {
    vi.useFakeTimers();
    try {
      const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValue({ kind: 'unavailable' }) });
      const view = render(wrap('es-CO', <OfferJourney quote={quote} api={api} poll={{ firstDelayMs: 100, maxDelayMs: 250, budgetMs: 2500 }} onRequote={vi.fn()} onConsentRequired={vi.fn()} onBack={vi.fn()} />));
      await act(async () => {});
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Aceptar oferta' })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(399); });
      expect(api.policyForAcceptance).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(api.policyForAcceptance).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(599); });
      expect(api.policyForAcceptance).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(api.policyForAcceptance).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(api.policyForAcceptance).toHaveBeenCalledTimes(4);
      expect(screen.getByRole('button', { name: 'Actualizar estado' })).toBeEnabled();
      expect(api.acceptOffer).toHaveBeenCalledTimes(1);
      expect(api.issuePolicy).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Póliza emitida' })).toBeNull();
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it('discovers an available document within 100 ms with the default polling schedule without repeating acceptance', async () => {
    vi.useFakeTimers();
    try {
      const api = stubs();
      const view = render(wrap('es-CO', <OfferJourney quote={quote} api={api} onRequote={vi.fn()} onConsentRequired={vi.fn()} onBack={vi.fn()} />));
      await act(async () => {});
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Aceptar oferta' })); });
      expect(screen.queryByRole('heading', { name: 'Póliza emitida' })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(screen.getByRole('heading', { name: 'Revisa tu póliza antes de confirmar' })).toBeInTheDocument();
      expect(api.acceptOffer).toHaveBeenCalledTimes(1);
      expect(api.issuePolicy).not.toHaveBeenCalled();
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it('discovers a document ready after several pending reads within 100 ms without issuing automatically', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const api = stubs({ policyForAcceptance: vi.fn().mockImplementation(async () => ready ? ok(pending) : { kind: 'notFound' }) });
      const view = render(wrap('es-CO', <OfferJourney quote={quote} api={api} onRequote={vi.fn()} onConsentRequired={vi.fn()} onBack={vi.fn()} />));
      await act(async () => {});
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Aceptar oferta' })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(screen.queryByRole('heading', { name: 'Revisa tu póliza antes de confirmar' })).toBeNull();
      ready = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(screen.getByRole('heading', { name: 'Revisa tu póliza antes de confirmar' })).toBeInTheDocument();
      expect(api.acceptOffer).toHaveBeenCalledTimes(1);
      expect(api.issuePolicy).not.toHaveBeenCalled();
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it('keeps review, confirmed payment and signature in steps 5, 6 and 7', async () => {
    const { api, user, container } = journey();
    expect(await screen.findByText(/77\.760/, { selector: '.offer-premium' })).toHaveTextContent('COP / mes');
    expect(screen.getByText(/academic-mortgage-1/)).toBeInTheDocument();
    expect(screen.getByText(/Vence el/)).toBeInTheDocument();
    expect(screen.getByText(/fuentes de datos simuladas/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Revisa tu póliza antes de confirmar' })).toBeInTheDocument();
    expect(api.policyForAcceptance).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('checkbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(screen.getByText(document)).toBeInTheDocument();
    expect(screen.getByText(new RegExp('a'.repeat(64)))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Obtener código de prueba' })).toBeNull();
    expect(api.issuePolicy).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Continuar al cobro' }));
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 6: Cobro');
    expect(api.chargePolicy).toHaveBeenCalledWith(pending, expect.any(String), expect.any(AbortSignal));
    expect(api.beginSignatureChallenge).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { level: 1, name: 'Cobro confirmado' })).toBeInTheDocument();
    expect(screen.getByText(receipt)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continuar a la firma' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Firma electrónica' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 7: Firma');
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
    await user.type(await screen.findByLabelText('Código de autenticación'), challenge.demoCode);
    await user.click(screen.getByRole('button', { name: 'Firmar póliza' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Póliza emitida' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 7: Firma');
    expect(screen.getByText(/Emitida · cobrada y firmada/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(issued.traceId))).toBeInTheDocument();
    expect(screen.getByText(/cobro y firma simulados/)).toBeInTheDocument();
    expect(api.createOffer).toHaveBeenCalledTimes(1);
    expect(api.acceptOffer).toHaveBeenCalledWith(offer.offerId, expect.any(String), expect.any(AbortSignal));
    expect(api.issuePolicy).toHaveBeenCalledWith(charged, expect.any(String), challenge.challengeId, challenge.demoCode, expect.any(AbortSignal));
    await waitFor(() => expect(live()).toHaveTextContent('Póliza emitida una sola vez.'));
  });

  it('keeps step 6 pending until the charge command confirms payment', async () => {
    const api = stubs({ chargePolicy: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok(charged)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    expect(await screen.findByRole('button', { name: 'Actualizar estado' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 6: Cobro');
    expect(api.beginSignatureChallenge).not.toHaveBeenCalled();
    expect(api.issuePolicy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    expect(await screen.findByRole('heading', { name: 'Cobro confirmado' })).toBeInTheDocument();
    expect(api.chargePolicy.mock.calls[0][1]).toBe(api.chargePolicy.mock.calls[1][1]);
  });

  it('reads the durable refund state when the charge expires before signing', async () => {
    const api = stubs({ chargePolicy: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'signature_failed' }),
      policyForAcceptance: vi.fn().mockResolvedValueOnce(ok(pending)).mockResolvedValue(ok({ ...charged,
        status: 'refunded', payment: { status: 'refunded', reference: receipt } })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    expect(await screen.findByRole('heading', { name: 'Cobro revertido' })).toBeInTheDocument();
    expect(api.issuePolicy).not.toHaveBeenCalled();
  });

  it('recovers a charge refund without asking for a signature challenge', async () => {
    const refunding = { ...charged, status: 'refunding' as const };
    const refunded = { ...charged, status: 'refunded' as const, payment: { status: 'refunded' as const, reference: receipt } };
    const api = stubs({ chargePolicy: vi.fn().mockResolvedValueOnce({ kind: 'rejected', code: 'signature_failed' })
      .mockResolvedValueOnce({ kind: 'rejected', code: 'signature_failed' }),
    policyForAcceptance: vi.fn().mockResolvedValueOnce(ok(pending)).mockResolvedValueOnce(ok(refunding)).mockResolvedValue(ok(refunded)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    await user.click(await screen.findByRole('button', { name: 'Verificar y recuperar operación' }));
    expect(await screen.findByRole('heading', { name: 'Cobro revertido' })).toBeInTheDocument();
    expect(api.chargePolicy).toHaveBeenCalledTimes(2);
    expect(api.issuePolicy).not.toHaveBeenCalled();
    expect(api.beginSignatureChallenge).not.toHaveBeenCalled();
    expect(api.chargePolicy.mock.calls[0][1]).toBe(api.chargePolicy.mock.calls[1][1]);
  });

  it('explains challenge expiry and allows a new attempt without issuing or charging again', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(challenge.expiresAt));
    const api = stubs({ beginSignatureChallenge: vi.fn().mockResolvedValueOnce(ok(challenge))
      .mockResolvedValue(ok({ ...challenge, expiresAt: new Date(Date.parse(challenge.expiresAt) + 60000).toISOString() })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(screen.getByRole('alert')).toHaveTextContent('El código expiró. Cancela este intento y solicita uno nuevo.');
    expect(screen.getByRole('button', { name: 'Firmar póliza' })).toBeDisabled();
    expect(api.issuePolicy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancelar firma' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
    await user.type(await screen.findByLabelText('Código de autenticación'), challenge.demoCode);
    expect(screen.getByRole('button', { name: 'Firmar póliza' })).toBeEnabled();
    expect(api.chargePolicy).toHaveBeenCalledTimes(1);
    expect(api.beginSignatureChallenge).toHaveBeenCalledTimes(2);
  });

  it('restores the signature form after retrying an unavailable challenge', async () => {
    const api = stubs({ beginSignatureChallenge: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok(challenge)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a la firma' }));
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Código de autenticación')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Firma electrónica' })).toBeInTheDocument();
    expect(api.beginSignatureChallenge).toHaveBeenCalledTimes(2);
  });

  it('restores the signature form after retrying an unavailable cancellation', async () => {
    const api = stubs({ cancelSignatureChallenge: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok(charged)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a la firma' }));
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
    await user.click(await screen.findByRole('button', { name: 'Cancelar firma' }));
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('heading', { name: 'Firma electrónica' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Obtener código de prueba' })).toBeInTheDocument();
    expect(api.cancelSignatureChallenge).toHaveBeenCalledTimes(2);
  });

  it('never shows the accepted 202 as an issued policy and offers a manual refresh when delivery is slow', async () => {
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValue({ kind: 'notFound' }) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Aceptación registrada' })).toBeInTheDocument();
    expect(screen.getByText('Pendiente de emisión')).toBeInTheDocument();
    expect(screen.queryByText('Póliza emitida')).toBeNull();
    const refresh = await screen.findByRole('button', { name: 'Actualizar estado' });
    api.policyForAcceptance.mockResolvedValue(ok(pending));
    await user.click(refresh);
    expect(await screen.findByRole('heading', { level: 1, name: 'Revisa tu póliza antes de confirmar' })).toBeInTheDocument();
  });

  it('survives StrictMode effect replay: the replayed request reuses its key and the offer still loads', async () => {
    const api = stubs();
    journey(api, 'es-CO', true);
    expect(await screen.findByRole('button', { name: 'Aceptar oferta' })).toBeEnabled();
    const keys = new Set(api.createOffer.mock.calls.map(call => call[1]));
    expect(keys.size).toBe(1);
    const signals = api.createOffer.mock.calls.map(call => call[2] as AbortSignal);
    expect(signals.at(-1)?.aborted).toBe(false);
  });

  it('does not restart when the language changes during creation and announces in the current language', async () => {
    let resolve!: (value: FinancialOutcome<Offer>) => void;
    const api = stubs({ createOffer: vi.fn().mockImplementation(() => new Promise(r => { resolve = r; })) });
    let switchTo: (locale: Locale) => void = () => {};
    function Switcher() { switchTo = useLocale().setLocale; return null; }
    render(<I18n initial="es-CO"><LiveRegion><Switcher /><OfferJourney quote={quote} api={api as never} poll={fast} onRequote={vi.fn()} onConsentRequired={vi.fn()} onBack={vi.fn()} /></LiveRegion></I18n>);
    act(() => switchTo('en-US'));
    await act(async () => resolve(ok(offer)));
    expect(await screen.findByRole('button', { name: 'Accept offer' })).toBeInTheDocument();
    expect(api.createOffer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(live()).toHaveTextContent('Definitive offer ready'));
  });

  it('ignores a response that arrives after the journey is unmounted', async () => {
    let resolve!: (value: FinancialOutcome<Offer>) => void;
    const api = stubs({ createOffer: vi.fn().mockImplementation(() => new Promise(r => { resolve = r; })) });
    const errors = vi.spyOn(console, 'error');
    const { unmount } = journey(api);
    const signal = api.createOffer.mock.calls[0][2] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(ok(offer)));
    expect(errors).not.toHaveBeenCalled();
  });

  it('reports an expired offer without issuance and requotes on request', async () => {
    const api = stubs({ acceptOffer: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'expired' }) });
    const { user, onRequote } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByRole('heading', { level: 1, name: `La oferta ${offer.offerId} expiró` })).toBeInTheDocument();
    expect(screen.getByText(/No se emitió ninguna póliza y no se generó ningún cobro/)).toBeInTheDocument();
    expect(api.policyForAcceptance).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Recotizar ahora' }));
    expect(onRequote).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed charge recoverable when the signing window expires during issuance', async () => {
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'offer_invalid' }) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Reverso pendiente' })).toBeInTheDocument();
    expect(readPurchaseDraft()).not.toBeNull();
    expect(screen.queryByText(/no se generó ningún cobro/)).toBeNull();
  });

  it('retries an uncertain issuance with the same key and never invents a new operation', async () => {
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok({ ...issued, replayed: true })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('no se repite el cobro');
    expect(screen.getByRole('heading', { level: 1, name: 'Firma electrónica' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 7: Firma');
    await user.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Póliza emitida' })).toBeInTheDocument();
    expect(api.issuePolicy).toHaveBeenCalledTimes(2);
    expect(api.issuePolicy.mock.calls[0][1]).toBe(api.issuePolicy.mock.calls[1][1]);
  });

  it('does not accept a success response that is not an issued policy for the reviewed document', async () => {
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValue(ok({ ...issued, documentHash: 'b'.repeat(64) })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar el resultado');
    expect(screen.queryByRole('heading', { name: 'Póliza emitida' })).toBeNull();
  });

  it('requires a new review when the document changed', async () => {
    const changed = { ...charged, document: document + '\n', documentHash: 'b'.repeat(64) };
    const api = stubs({
      policyForAcceptance: vi.fn().mockResolvedValueOnce(ok(pending)).mockResolvedValue(ok(changed)),
      chargePolicy: vi.fn().mockImplementation(async (policy: Policy) => ok({ ...charged, document: policy.document, documentHash: policy.documentHash })),
      issuePolicy: vi.fn().mockResolvedValueOnce({ kind: 'rejected', code: 'document_mismatch' }).mockResolvedValue(ok({ ...changed, status: 'issued', payment: issued.payment }))
    });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Volvimos a consultar el documento');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Firmar póliza' })).toBeNull();
    expect(api.policyForAcceptance).toHaveBeenCalledTimes(2);
    expect(screen.getByText(new RegExp(changed.documentHash))).toBeInTheDocument();
    await signFromReview(user);
    expect(await screen.findByRole('heading', { name: 'Póliza emitida' })).toBeInTheDocument();
    expect(api.issuePolicy.mock.calls[1][0].documentHash).toBe(changed.documentHash);
    expect(api.acceptOffer).toHaveBeenCalledTimes(1);
  });

  it.each(['refunded', 'issued'] as const)('reads the authoritative %s policy when challenge creation rejects the offer', async status => {
    const terminal = status === 'issued' ? issued : { ...charged, status, payment: { status: 'refunded' as const, reference: receipt } };
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValueOnce(ok(pending)).mockResolvedValue(ok(terminal)),
      beginSignatureChallenge: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'offer_invalid' }) });
    const { user, onRequote } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a la firma' }));
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
    expect(await screen.findByRole('heading', { level: 1, name: status === 'issued' ? 'Póliza emitida' : 'Cobro revertido' })).toBeInTheDocument();
    await waitFor(() => expect(readPurchaseDraft()).toBeNull());
    expect(api.chargePolicy).toHaveBeenCalledTimes(1);
    expect(api.issuePolicy).not.toHaveBeenCalled();
    if (status === 'refunded') {
      await user.click(screen.getByRole('button', { name: 'Recotizar ahora' }));
      expect(onRequote).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps an expired charged purchase recoverable through read and refund outages with its original charge key', async () => {
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValueOnce(ok(pending)).mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce(ok(charged)).mockResolvedValue(ok({ ...charged, status: 'refunded', payment: { status: 'refunded', reference: receipt } })),
    beginSignatureChallenge: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'offer_invalid' }),
    chargePolicy: vi.fn().mockResolvedValueOnce(ok(charged)).mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValue({ kind: 'rejected', code: 'signature_failed' }) });
    const { user, onRequote } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a la firma' }));
    await user.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await user.click(screen.getByRole('checkbox'));
    const original = readPurchaseDraft();
    await user.click(screen.getByRole('button', { name: 'Obtener código de prueba' }));
    await user.click(await screen.findByRole('button', { name: 'Actualizar estado' }));
    expect(await screen.findByRole('heading', { name: 'Reverso pendiente' })).toBeInTheDocument();
    expect(readPurchaseDraft()).toEqual(original);
    expect(screen.queryByRole('button', { name: 'Recotizar ahora' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verificar y recuperar operación' }));
    await user.click(await screen.findByRole('button', { name: 'Actualizar estado' }));
    expect(await screen.findByRole('heading', { name: 'Cobro revertido' })).toBeInTheDocument();
    expect(new Set(api.chargePolicy.mock.calls.map(call => call[1])).size).toBe(1);
    expect(api.chargePolicy).toHaveBeenCalledTimes(3);
    expect(api.issuePolicy).not.toHaveBeenCalled();
    expect(api.beginSignatureChallenge).toHaveBeenCalledTimes(1);
    expect(api.acceptOffer).toHaveBeenCalledTimes(1);
    expect(onRequote).not.toHaveBeenCalled();
    await waitFor(() => expect(readPurchaseDraft()).toBeNull());
  });

  it('does not claim a completed refund from signature_failed and recovers with the same operation key', async () => {
    const api = stubs({
      policyForAcceptance: vi.fn().mockResolvedValueOnce(ok(pending))
        .mockResolvedValueOnce(ok({ ...charged, status: 'refunding' })).mockResolvedValue(ok({ ...charged, status: 'refunded', payment: { status: 'refunded', reference: receipt } })),
      issuePolicy: vi.fn().mockResolvedValueOnce({ kind: 'rejected', code: 'signature_failed' }).mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue({ kind: 'rejected', code: 'signature_failed' })
    });
    const { user, onRequote } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(await screen.findByRole('heading', { name: 'Reverso pendiente' })).toBeInTheDocument();
    expect(screen.queryByText(/El cobro fue revertido/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recotizar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verificar y recuperar operación' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verificar y recuperar operación' })).toBeEnabled());
    expect(screen.queryByText(/El cobro fue revertido/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verificar y recuperar operación' }));
    expect(await screen.findByRole('heading', { name: 'Cobro revertido' })).toBeInTheDocument();
    expect(screen.getByText(/El cobro fue revertido y no se emitió/)).toBeInTheDocument();
    expect(new Set(api.issuePolicy.mock.calls.map(call => call[1])).size).toBe(1);
    expect(api.issuePolicy).toHaveBeenCalledTimes(3);
    expect(api.acceptOffer).toHaveBeenCalledTimes(1);
    expect(onRequote).not.toHaveBeenCalled();
  });

  it('shows a policy already issued by another request without another charge or signature confirmation', async () => {
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValue(ok(issued)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByRole('heading', { name: 'Póliza emitida' })).toBeInTheDocument();
    expect(api.issuePolicy).not.toHaveBeenCalled();
  });

  it('ends a rejected issuance without claiming a policy', async () => {
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'integrity_violation' }) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'No pudimos completar esta operación' })).toBeInTheDocument();
    expect(screen.getByText(/No pudimos continuar con esta oferta/)).toBeInTheDocument();
  });

  it('shows a declined charge as final for this policy and retries through a new offer with the same data', async () => {
    const api = stubs({ chargePolicy: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'payment_declined' }) });
    const { user, onRequote, container } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar al cobro' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'El cobro no se pudo completar' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 6: Cobro');
    expect(screen.getByText('La póliza no se emitió y no se generó ningún cargo.')).toBeInTheDocument();
    expect(screen.getByText(/el valor podría cambiar/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cambiar medio de pago' })).toBeNull();
    await waitFor(() => expect(live()).toHaveTextContent('El cobro fue rechazado.'));
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Reintentar cobro' }));
    expect(onRequote).toHaveBeenCalledTimes(1);
    expect(api.issuePolicy).not.toHaveBeenCalled();
  });

  it('opens a policy whose charge was already declined on the declined state instead of asking to pay again', async () => {
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValue(ok({ ...pending, payment: { status: 'declined', reference: null } })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'El cobro no se pudo completar' })).toBeInTheDocument();
    expect(api.issuePolicy).not.toHaveBeenCalled();
  });

  it('prevents signing and cancellation from racing a pending signature', async () => {
    let finish: (value: FinancialOutcome<Policy>) => void = () => {};
    const api = stubs({ issuePolicy: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    const confirm = screen.getByRole('button', { name: 'Firmar póliza' });
    const cancel = screen.getByRole('button', { name: 'Cancelar firma' });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    expect(screen.getByLabelText('Código de autenticación')).toBeDisabled();
    await user.click(confirm); await user.click(cancel);
    expect(api.issuePolicy).toHaveBeenCalledTimes(1);
    expect(api.cancelSignatureChallenge).not.toHaveBeenCalled();
    await act(async () => { finish(ok(issued)); });
    expect(await screen.findByRole('heading', { name: 'Póliza emitida' })).toBeInTheDocument();
  });

  it('prevents duplicate cancellation and signing until cancellation is confirmed', async () => {
    let finish: (value: FinancialOutcome<Policy>) => void = () => {};
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'authentication_failed' }),
      cancelSignatureChallenge: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    const cancel = screen.getByRole('button', { name: 'Cancelar firma' });
    await user.click(cancel);
    expect(cancel).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Firmar póliza' })).toBeDisabled();
    await user.click(cancel);
    expect(api.cancelSignatureChallenge).toHaveBeenCalledTimes(1);
    expect(api.issuePolicy).toHaveBeenCalledTimes(1);
    await act(async () => { finish(ok(charged)); });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.queryByLabelText('Código de autenticación')).toBeNull();
    expect(screen.getByRole('button', { name: 'Obtener código de prueba' })).toBeDisabled();
  });

  it('shows issuance confirmed by cancellation when another valid signature completed first', async () => {
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'authentication_failed' }),
      cancelSignatureChallenge: vi.fn().mockResolvedValue(ok(issued)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    await user.click(screen.getByRole('button', { name: 'Cancelar firma' }));
    expect(await screen.findByRole('heading', { name: 'Póliza emitida' })).toBeInTheDocument();
    expect(readPurchaseDraft()).toBeNull();
    expect(api.issuePolicy).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain signature retry inert while its request is in flight', async () => {
    let finish: (value: FinancialOutcome<Policy>) => void = () => {};
    const api = stubs({ issuePolicy: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await signFromReview(user);
    const refresh = await screen.findByRole('button', { name: 'Actualizar estado' });
    expect(screen.getByRole('button', { name: 'Firmar póliza' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar firma' })).toBeDisabled();
    await user.click(refresh);
    expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await user.click(refresh); await user.click(refresh);
    expect(api.issuePolicy).toHaveBeenCalledTimes(2);
    await act(async () => { finish(ok({ ...issued, replayed: true })); });
    expect(await screen.findByRole('heading', { level: 1, name: 'Póliza emitida' })).toBeInTheDocument();
    expect(new Set(api.issuePolicy.mock.calls.map(call => call[1])).size).toBe(1);
  });

  it('shows the underwriting decline without an offer', async () => {
    journey(stubs({ createOffer: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'declined' }) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'No es posible emitir una oferta definitiva' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceptar oferta' })).toBeNull();
  });

  it('explains an offer accepted elsewhere instead of continuing silently', async () => {
    const { user } = journey(stubs({ acceptOffer: vi.fn().mockResolvedValue({ kind: 'rejected', code: 'conflict' }) }));
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByText(/Si la aceptaste en otra pestaña/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No se emitió la póliza' })).toBeNull();
  });

  it('returns to consent when the server requires a current authorization', async () => {
    const { onConsentRequired } = journey(stubs({ createOffer: vi.fn().mockResolvedValue({ kind: 'consentRequired' }) }));
    await waitFor(() => expect(onConsentRequired).toHaveBeenCalledTimes(1));
  });

  it('hands a lost session back to sign-in during acceptance', async () => {
    const { user, onSessionLost } = journey(stubs({ acceptOffer: vi.fn().mockResolvedValue({ kind: 'unauthenticated' }) }));
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledTimes(1));
  });

  it('retries an unavailable acceptance with the same key', async () => {
    const api = stubs({ acceptOffer: vi.fn().mockResolvedValueOnce({ kind: 'unavailable', traceId: '60000000-0000-4000-8000-000000000006' }).mockResolvedValue(ok(acceptance)) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByText(/60000000-0000-4000-8000-000000000006/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Revisa tu póliza antes de confirmar' })).toBeInTheDocument();
    expect(api.acceptOffer.mock.calls[0][1]).toBe(api.acceptOffer.mock.calls[1][1]);
  });

  it('stores the acceptance and signature command key until issuance is confirmed', async () => {
    let finish: (value: FinancialOutcome<Policy>) => void = () => {};
    const api = stubs({ issuePolicy: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
    const { user } = journey(api);
    await user.click(await screen.findByRole('button', { name: 'Aceptar oferta' }));
    await screen.findByRole('heading', { name: 'Revisa tu póliza antes de confirmar' });
    expect(readPurchaseDraft()).toEqual({ quoteId: quote.quoteId, acceptance, issue: null });
    await signFromReview(user);
    expect(readPurchaseDraft()?.issue).toEqual({ policyId: pending.policyId, documentHash: pending.documentHash,
      key: api.issuePolicy.mock.calls[0][1], challengeId: challenge.challengeId });
    await act(async () => { finish(ok(issued)); });
    expect(await screen.findByRole('heading', { level: 1, name: 'Póliza emitida' })).toBeInTheDocument();
    expect(readPurchaseDraft()).toBeNull();
  });

  it('resumes an interrupted signature after a reload with the original key', async () => {
    const key = '70000000-0000-4000-8000-000000000007';
    savePurchaseDraft({ quoteId: quote.quoteId, acceptance, issue: { policyId: pending.policyId, documentHash: pending.documentHash,
      key, challengeId: challenge.challengeId } });
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValue(ok({ ...pending, status: 'charged', payment: { status: 'confirmed', reference: receipt } })) });
    const user = userEvent.setup();
    render(wrap('es-CO', <OfferJourney quote={{ quoteId: quote.quoteId }} resume={readPurchaseDraft() ?? undefined} api={api as never} poll={fast} onRequote={vi.fn()} onConsentRequired={vi.fn()} onBack={vi.fn()} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Firma electrónica' })).toBeInTheDocument();
    expect(api.createOffer).not.toHaveBeenCalled();
    expect(api.acceptOffer).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Actualizar estado' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Póliza emitida' })).toBeInTheDocument();
    expect(api.issuePolicy).toHaveBeenCalledWith(expect.objectContaining({ policyId: pending.policyId }), key,
      challenge.challengeId, '000000', expect.any(AbortSignal));
    expect(readPurchaseDraft()).toBeNull();
  });

  it('resumes at document review when no payment command was sent before the reload', async () => {
    savePurchaseDraft({ quoteId: quote.quoteId, acceptance, issue: null });
    const api = stubs({ policyForAcceptance: vi.fn().mockResolvedValue(ok(pending)) });
    render(wrap('es-CO', <OfferJourney quote={{ quoteId: quote.quoteId }} resume={readPurchaseDraft() ?? undefined} api={api as never} poll={fast} onRequote={vi.fn()} onConsentRequired={vi.fn()} onBack={vi.fn()} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Revisa tu póliza antes de confirmar' })).toBeInTheDocument();
    expect(api.issuePolicy).not.toHaveBeenCalled();
  });

  it('renders in English', async () => {
    journey(stubs(), 'en-US');
    expect(await screen.findByRole('button', { name: 'Accept offer' })).toBeInTheDocument();
    expect(screen.getByText(/Expires on/)).toBeInTheDocument();
  });
});

describe('quote flow continuation', () => {
  it('opens a purchase interrupted by a reload on its policy, and sends the user to the form when leaving it', async () => {
    savePurchaseDraft({ quoteId: quote.quoteId, acceptance, issue: null });
    const financial = stubs({ policyForAcceptance: vi.fn().mockResolvedValue(ok({ ...pending, payment: { status: 'declined', reference: null } })) });
    const user = userEvent.setup();
    render(wrap('es-CO', <QuoteFlow financial={financial as never} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'El cobro no se pudo completar' })).toBeInTheDocument();
    expect(financial.createOffer).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reintentar cobro' }));
    expect(await screen.findByRole('button', { name: 'Calcular cotización' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  const terms = { purposeCode: 'risk_profiling', textVersion: 2, validityDays: 90, sources: [
    { code: 'open_finance_bancolombia', scope: 'income_obligations_12m', kind: 'open_finance' },
    { code: 'datacredito_experian', scope: 'payment_history_score', kind: 'credit_bureau' },
    { code: 'ruaf', scope: 'affiliation_regime', kind: 'open_data' },
    { code: 'registraduria', scope: 'identity_validation', kind: 'open_data' }] };
  const consent: Consent = { consentId: 'CNS-2026-00003', status: 'active', sources: [], scopes: [], grantedAt: '2026-10-08T15:00:00Z', expiresAt: '2027-01-06T15:00:00Z', revokedAt: null, seal: 'a'.repeat(64) };
  const requoted: Quote = { ...quote, quoteId: 'COT-2026-08844' };

  it('requotes an expired offer from the same form data with a new quote key and requests a fresh offer', async () => {
    const request = vi.fn().mockResolvedValueOnce({ kind: 'quote', quote }).mockResolvedValueOnce({ kind: 'quote', quote: requoted });
    const consentApi = { getTerms: vi.fn().mockResolvedValue({ kind: 'ok', value: terms }), grantConsent: vi.fn().mockResolvedValue({ kind: 'ok', value: consent }), declineConsent: vi.fn() };
    const financial = stubs({ createOffer: vi.fn().mockResolvedValueOnce({ kind: 'rejected', code: 'expired' }).mockResolvedValue(ok({ ...offer, quoteId: requoted.quoteId })) });
    const user = userEvent.setup();
    render(wrap('es-CO', <QuoteFlow request={request as never} consent={consentApi as never} financial={financial as never} />));
    for (const [label, value] of [[/Nombre completo/, 'Cliente Sintetico Uno'], [/Documento/, '1000000001'], [/Fecha de nacimiento/, '1992-03-14'], [/Ciudad/, 'Bogotá D.C.'], [/Monto/, '320000000'], [/Plazo/, '180']] as const) {
      await user.type(screen.getByLabelText(label), value);
    }
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a autorización de datos' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    await user.click(await screen.findByRole('button', { name: 'Ver oferta definitiva' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'La oferta expiró' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recotizar ahora' }));
    expect(await screen.findByRole('button', { name: 'Aceptar oferta' })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toEqual(request.mock.calls[0][0]);
    expect(request.mock.calls[1][1]).not.toBe(request.mock.calls[0][1]);
    expect(financial.createOffer.mock.calls.map(call => call[0])).toEqual([quote.quoteId, requoted.quoteId]);
  });
});

describe('consent confirmation continuation', () => {
  const consent: Consent = { consentId: 'CNS-2026-00003', status: 'active', sources: [], scopes: [], grantedAt: '2026-10-08T15:00:00Z', expiresAt: '2027-01-06T15:00:00Z', revokedAt: null, seal: 'a'.repeat(64) };
  it('continues to the offer only from a confirmed active authorization', () => {
    const { rerender } = render(wrap('es-CO', <ConsentGranted consent={consent} onBack={vi.fn()} onOffer={vi.fn()} />));
    expect(screen.getByRole('button', { name: 'Ver oferta definitiva' })).toBeInTheDocument();
    rerender(wrap('es-CO', <ConsentGranted consent={consent} uncertain onBack={vi.fn()} onOffer={vi.fn()} />));
    expect(screen.queryByRole('button', { name: 'Ver oferta definitiva' })).toBeNull();
    rerender(wrap('es-CO', <ConsentGranted consent={{ ...consent, status: 'revoked' }} onBack={vi.fn()} onOffer={vi.fn()} />));
    expect(screen.queryByRole('button', { name: 'Ver oferta definitiva' })).toBeNull();
  });
});

describe('financial API client', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const offerBody = { ...offer, product: 'vida_hipotecario', coverage: { kind: 'mortgage_life', sumInsured: offer.sumInsured }, synthetic: true, status: 'definitive' };
  delete (offerBody as Record<string, unknown>).sumInsured;
  const fetchMock = (response: Response) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

  it('sends the key and an empty JSON body, and accepts only a valid owned definitive offer', async () => {
    const spy = fetchMock(json(201, offerBody));
    expect(await createOffer(quote.quoteId, 'key-1')).toEqual(ok(offer));
    const [path, init] = spy.mock.calls[0];
    expect(path).toBe(`/api/v1/quotes/${quote.quoteId}/offers`);
    expect((init as RequestInit).body).toBe('{}');
    expect(new Headers((init as RequestInit).headers).get('idempotency-key')).toBe('key-1');
  });

  it.each([
    ['another quote', { ...offerBody, quoteId: 'COT-2026-00001' }],
    ['a floating amount', { ...offerBody, premium: '77760.5' }],
    ['a preliminary status', { ...offerBody, status: 'preliminary' }],
    ['a non-synthetic offer', { ...offerBody, synthetic: false }]
  ])('rejects %s as unavailable', async (_label, body) => {
    fetchMock(json(200, body, { 'x-trace-id': offer.traceId }));
    expect(await createOffer(quote.quoteId, 'key-1')).toEqual({ kind: 'unavailable', traceId: offer.traceId });
  });

  it('maps consent, expiry and decline responses', async () => {
    fetchMock(json(403, { error: 'consent_required' }));
    expect(await createOffer(quote.quoteId, 'k')).toEqual({ kind: 'consentRequired' });
    vi.restoreAllMocks(); fetchMock(json(409, { error: 'expired' }));
    expect(await acceptOffer(offer.offerId, 'k')).toEqual({ kind: 'rejected', code: 'expired' });
    vi.restoreAllMocks(); fetchMock(json(409, { error: '<script>' }));
    expect(await acceptOffer(offer.offerId, 'k')).toEqual({ kind: 'rejected', code: 'conflict' });
    vi.restoreAllMocks(); fetchMock(json(418, {}));
    expect(await acceptOffer(offer.offerId, 'k')).toEqual({ kind: 'unavailable' });
  });

  it('reads a pending policy only for the accepted offer and binds issuance to the reviewed hash', async () => {
    const { payment: _absent, ...withoutPayment } = pending;
    const policyBody = { ...withoutPayment, offerVersion: 1, synthetic: true, providerMode: 'mock' };
    fetchMock(json(404, { error: 'not_found' }));
    expect(await policyForAcceptance(acceptance)).toEqual({ kind: 'notFound' });
    vi.restoreAllMocks(); fetchMock(json(200, { ...policyBody, offerId: '90000000-0000-4000-8000-000000000009' }));
    expect((await policyForAcceptance(acceptance)).kind).toBe('unavailable');
    vi.restoreAllMocks(); const spy = fetchMock(json(200, { ...policyBody, status: 'issued', payment: issued.payment }));
    expect(await issuePolicy(pending, 'issue-key', challenge.challengeId, challenge.demoCode)).toEqual(ok({ ...pending, status: 'issued', payment: issued.payment }));
    expect(JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body))).toEqual({ documentHash: pending.documentHash,
      challengeId: challenge.challengeId, code: challenge.demoCode });
  });

  it.each(['not-json', 'null', '[]', '"document"'])('rejects an invalid document object before it can reach the paged viewer: %s', async document => {
    fetchMock(json(200, { ...pending, offerVersion: 1, synthetic: true, providerMode: 'mock', document }));
    expect((await policyForAcceptance(acceptance)).kind).toBe('unavailable');
  });

  it('accepts only a well-formed premium state with a receipt exactly when the provider acknowledged it', async () => {
    const { payment: _absent, ...withoutPayment } = pending;
    const body = { ...withoutPayment, offerVersion: 1, synthetic: true, providerMode: 'mock' };
    for (const payment of [{ status: 'pending', reference: null }, { status: 'declined', reference: null }, { status: 'refunded', reference: receipt }]) {
      vi.restoreAllMocks(); fetchMock(json(200, { ...body, payment }));
      expect(await policyForAcceptance(acceptance)).toEqual(ok({ ...pending, payment }));
    }
    for (const payment of [null, { status: 'confirmed', reference: null }, { status: 'pending', reference: receipt }, { status: 'confirmed', reference: 'REC-9931-2026' },
      { status: 'succeeded', reference: receipt }, { ...issued.payment, amount: '1.0000' }]) {
      vi.restoreAllMocks(); fetchMock(json(200, { ...body, payment }));
      expect((await policyForAcceptance(acceptance)).kind, JSON.stringify(payment)).toBe('unavailable');
    }
  });

  it('rethrows an aborted request so callers can ignore it', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(createOffer(quote.quoteId, 'k')).rejects.toThrow('Aborted');
  });
});
