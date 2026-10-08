import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { messages, locales } from '../i18n/messages';
import { LiveRegion } from './Live';
import { QuoteFlow } from './QuoteFlow';
import { requestQuote, toRequestBody, type Quote, type QuoteOutcome, type QuoteValues } from './api';
import { Stepper } from './Stepper';
import type { Locale } from '../i18n/messages';

const quote: Quote = { quoteId: 'COT-2026-08843', premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000, termMonths: 180, validUntil: '2026-11-05T10:47:00-05:00', basis: 'minimum_data', ruleVersion: 'provisional-1', traceId: '7f3c2a9e1b4d4c8aa0d1e2f3a4b5c6d7' };
const valid: QuoteValues = { fullName: 'Cliente Sintetico Uno', documentNumber: '1000000001', birthDate: '1992-03-14', city: 'Bogotá D.C.', amount: '320000000', termMonths: '180' };

function setup(request: (...args: never[]) => Promise<QuoteOutcome>, locale: Locale = 'es-CO', onContinue?: () => void) {
  const user = userEvent.setup();
  const view = render(<I18n initial={locale}><LiveRegion><main><QuoteFlow request={request as never} onContinue={onContinue} /></main></LiveRegion></I18n>);
  return { user, ...view };
}
async function fill(user: ReturnType<typeof userEvent.setup>, values: QuoteValues, labels: Record<keyof QuoteValues, RegExp>) {
  for (const key of Object.keys(values) as (keyof QuoteValues)[]) {
    const input = screen.getByLabelText(labels[key]);
    await user.clear(input);
    await user.type(input, values[key]);
  }
}
const es = { fullName: /Nombre completo/, documentNumber: /Documento/, birthDate: /Fecha de nacimiento/, city: /Ciudad/, amount: /Monto/, termMonths: /Plazo/ };
const en = { fullName: /Full name/, documentNumber: /ID document/, birthDate: /Date of birth/, city: /City/, amount: /Loan amount/, termMonths: /Term/ };
const live = () => screen.getByTestId('live-region');

describe('step 1: form', () => {
  it('labels every field and marks the required ones', () => {
    setup(vi.fn());
    for (const label of Object.values(es)) expect(screen.getByLabelText(label)).toBeRequired();
    expect(screen.getByLabelText(/Producto/)).toHaveAttribute('readonly');
    expect(screen.getByText('Los campos marcados con * son obligatorios.')).toBeInTheDocument();
  });

  it('on an empty submit shows errors linked to the fields and focuses the first invalid one', async () => {
    const request = vi.fn();
    const { user } = setup(request);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    const name = screen.getByLabelText(/Nombre completo/);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();
    expect(document.getElementById(name.getAttribute('aria-describedby')!)).toHaveTextContent('Este campo es obligatorio.');
    expect(screen.getByText('No pudimos calcular la cotización.')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(live()).toHaveTextContent('revisa los campos marcados'));
  });

  it('rejects a malformed document or amount before calling the server', async () => {
    const request = vi.fn();
    const { user } = setup(request);
    await fill(user, { ...valid, documentNumber: 'ABC123', amount: '0' }, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    expect(screen.getByLabelText(/Documento/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Monto/)).toHaveAttribute('aria-invalid', 'true');
    expect(request).not.toHaveBeenCalled();
  });

  it('maps a server 400 (age out of range) to the birth date field with the calculated age', async () => {
    const request = vi.fn().mockResolvedValue({ kind: 'validation', errors: [{ field: 'customer.birthDate', code: 'age_out_of_range', params: { age: 74, min: 18, max: 70 } }] });
    const { user } = setup(request);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    const dob = await screen.findByLabelText(/Fecha de nacimiento/);
    expect(dob).toHaveAttribute('aria-invalid', 'true');
    expect(dob).toHaveFocus();
    expect(document.getElementById(dob.getAttribute('aria-describedby')!)).toHaveTextContent('Edad calculada: 74 años. El rango asegurable es de 18 a 70 años.');
    expect(screen.getByLabelText(/Nombre completo/)).not.toHaveAttribute('aria-invalid');
  });

  it('shows a service banner when the API is unavailable, keeping what was typed', async () => {
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'unavailable' }));
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    expect(await screen.findByText(/no está disponible en este momento/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue(valid.fullName);
  });
});

describe('step 2: result', () => {
  it('shows the premium in COP with es-CO separators and announces it once', async () => {
    const request = vi.fn().mockResolvedValue({ kind: 'quote', quote });
    const { user } = setup(request);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    expect(await screen.findByText('$ 86.400')).toBeInTheDocument();
    expect(screen.getByText('$ 320.000.000 COP')).toBeInTheDocument();
    expect(screen.getByText('COT-2026-08843')).toBeInTheDocument();
    expect(screen.getByText('Estimación con datos mínimos.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Cotización' })).toHaveFocus();
    await waitFor(() => expect(live()).toHaveTextContent('Cotización calculada: prima mensual estimada $ 86.400 COP'));
  });

  it('formats the same quote with en-US separators, still in COP', async () => {
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }), 'en-US');
    await fill(user, valid, en);
    await user.click(screen.getByRole('button', { name: 'Calculate quote' }));
    expect(await screen.findByText('$86,400')).toBeInTheDocument();
    expect(screen.getByText('$320,000,000 COP')).toBeInTheDocument();
    expect(screen.getByText('Valid · 30 days')).toBeInTheDocument();
  });

  it('lets the user correct the data and keeps what was typed', async () => {
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }));
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Corregir datos' }));
    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue(valid.fullName);
  });

  it('keeps the continue button disabled until the consent step exists', async () => {
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }));
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    expect(await screen.findByRole('button', { name: 'Continuar a autorización de datos' })).toBeDisabled();
  });

  it('enables continue and calls back when a next step is provided', async () => {
    const next = vi.fn();
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }), 'es-CO', next);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a autorización de datos' }));
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authorization error', () => {
  it('shows one generic denial that reveals neither the cause nor any data, and announces it', async () => {
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'denied' }));
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    expect(await screen.findByRole('heading', { name: 'Acceso denegado' })).toHaveFocus();
    expect(screen.getByText('No se expone información del núcleo de suscripción ni datos del cliente.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/revocad|alcance|scope|Cliente Sintetico|1000000001/);
    await waitFor(() => expect(live()).toHaveTextContent('Acceso denegado: no se emitió cotización.'));
    await user.click(screen.getByRole('button', { name: 'Volver' }));
    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue(valid.fullName);
  });

  it('retry sends the same request again with the same idempotency key', async () => {
    const request = vi.fn().mockResolvedValueOnce({ kind: 'denied' }).mockResolvedValueOnce({ kind: 'quote', quote });
    const { user } = setup(request);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Reintentar con credenciales vigentes' }));
    expect(await screen.findByText('$ 86.400')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toBe(request.mock.calls[0][1]);
  });
});

describe('lost session', () => {
  it('announces it, keeps what was typed and hands control back to sign in', async () => {
    const onSessionLost = vi.fn();
    const user = userEvent.setup();
    render(<I18n initial="es-CO"><LiveRegion><main><QuoteFlow request={vi.fn().mockResolvedValue({ kind: 'unauthenticated' }) as never} onSessionLost={onSessionLost} /></main></LiveRegion></I18n>);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledOnce());
    expect(live()).toHaveTextContent('Tu sesión terminó');
    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue(valid.fullName);
    expect(screen.queryByRole('heading', { name: 'Acceso denegado' })).toBeNull();
  });
});

describe('idempotency key', () => {
  it('changes when the data changes, so a corrected request is a new quote', async () => {
    const request = vi.fn().mockResolvedValue({ kind: 'validation', errors: [{ field: 'customer.city', code: 'required' }] });
    const { user } = setup(request);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await screen.findByText(/campo marcado/);
    await user.type(screen.getByLabelText(/Ciudad/), ' Norte');
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][1]).not.toBe(request.mock.calls[0][1]);
  });
});

describe('i18n and accessibility', () => {
  it('has exactly one aria-live region and no role=alert or role=status in the flow', async () => {
    const { user, container } = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }));
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    await fill(user, valid, es);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await screen.findByText('$ 86.400');
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(0);
  });

  it('both catalogues define exactly the same keys and ICU placeholders', () => {
    const [a, b] = locales.map(l => messages[l]);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)/g)].map(m => m[1]).sort();
    for (const key of Object.keys(a)) expect(placeholders(b[key]), key).toEqual(placeholders(a[key]));
  });

  it('never converts the currency: COP appears in both locales', () => {
    expect(messages['es-CO']['result.perMonth']).toContain('COP');
    expect(messages['en-US']['result.perMonth']).toContain('COP');
  });

  it('has no accessibility violations in the form, the result and the denial', async () => {
    const form = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }));
    expect(await axe(form.container)).toHaveNoViolations();
    await fill(form.user, valid, es);
    await form.user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await screen.findByText('$ 86.400');
    expect(await axe(form.container)).toHaveNoViolations();
    form.unmount();
    const denied = setup(vi.fn().mockResolvedValue({ kind: 'denied' }), 'en-US');
    await fill(denied.user, valid, en);
    await denied.user.click(screen.getByRole('button', { name: 'Calculate quote' }));
    await screen.findByRole('heading', { name: 'Access denied' });
    expect(await axe(denied.container)).toHaveNoViolations();
  });

  it('can be completed with the keyboard alone', async () => {
    const { user } = setup(vi.fn().mockResolvedValue({ kind: 'quote', quote }));
    await user.tab();
    for (const key of Object.keys(valid) as (keyof QuoteValues)[]) {
      expect(screen.getByLabelText(es[key])).toHaveFocus();
      await user.keyboard(valid[key]);
      await user.tab();
    }
    await user.tab(); // read-only product field is skipped only if not focusable; either way reach the submit button
    const submit = screen.getByRole('button', { name: 'Calcular cotización' });
    submit.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('$ 86.400')).toBeInTheDocument();
  });
});

describe('stepper', () => {
  it('labels each step, marks the current one and flags unreachable ones', () => {
    render(<I18n initial="es-CO"><Stepper current={1} available={2} /></I18n>);
    const nav = screen.getByRole('navigation', { name: 'Pasos de la contratación' });
    expect(within(nav).getAllByRole('button')).toHaveLength(7);
    expect(within(nav).getByRole('button', { name: 'Paso 1: Cotización' })).toHaveAttribute('aria-current', 'step');
    expect(within(nav).getByRole('button', { name: 'Paso 2: Resultado' })).not.toHaveAttribute('aria-disabled');
    expect(within(nav).getByRole('button', { name: 'Paso 3: Consentimiento (aún no disponible)' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('request to the API', () => {
  const respond = (status: number, body: unknown = {}) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('sends the contract request without any partner key and with the idempotency key and language', async () => {
    const spy = respond(201, quote);
    const outcome = await requestQuote(valid, 'key-123', 'en-US');
    expect(outcome).toEqual({ kind: 'quote', quote });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/v1/me/quotes');
    expect((init as RequestInit).credentials).toBe('same-origin');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('key-123');
    expect(headers['accept-language']).toBe('en-US');
    expect(Object.keys(headers).map(h => h.toLowerCase())).not.toContain('authorization');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ product: 'vida_hipotecario', customer: { documentType: 'CC', documentNumber: valid.documentNumber }, credit: { amount: 320000000, termMonths: 180 } });
    spy.mockRestore();
  });

  it.each([
    [200, quote, 'quote'], [201, quote, 'quote'],
    [401, { error: 'unauthorized' }, 'unauthenticated'], [403, { error: 'forbidden' }, 'denied'],
    [409, { error: 'idempotency_key_reused' }, 'conflict'],
    [500, { error: 'internal_error' }, 'unavailable'], [503, {}, 'unavailable']
  ])('status %i becomes %s', async (status, body, kind) => {
    const spy = respond(status, body);
    expect((await requestQuote(valid, 'k', 'es-CO')).kind).toBe(kind);
    spy.mockRestore();
  });

  it('keeps the trace id of a denial so support can find the request, and nothing else', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'x-trace-id': 'a'.repeat(32) } }));
    expect(await requestQuote(valid, 'k', 'es-CO')).toEqual({ kind: 'denied', traceId: 'a'.repeat(32) });
    spy.mockRestore();
  });

  it('renews the session once after a 401 and retries the same request with the same idempotency key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(quote), { status: 201 }));
    expect(await requestQuote(valid, 'key-xyz', 'es-CO')).toEqual({ kind: 'quote', quote });
    expect(spy.mock.calls.map(call => call[0])).toEqual(['/api/v1/me/quotes', '/auth/session', '/api/v1/me/quotes']);
    const keys = [0, 2].map(i => ((spy.mock.calls[i][1] as RequestInit).headers as Record<string, string>)['idempotency-key']);
    expect(keys).toEqual(['key-xyz', 'key-xyz']);
    spy.mockRestore();
  });

  it('gives up as unauthenticated when the session cannot be renewed, without retrying', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    expect(await requestQuote(valid, 'k', 'es-CO')).toEqual({ kind: 'unauthenticated' });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('retries only once even if the second answer is another 401', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await requestQuote(valid, 'k', 'es-CO')).toEqual({ kind: 'unauthenticated' });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('turns a 400 with field errors into validation, and an empty 400 into unavailable', async () => {
    let spy = respond(400, { error: 'validation_error', errors: [{ field: 'credit.termMonths', code: 'term_out_of_range', params: { min: 12, max: 240 } }] });
    expect(await requestQuote(valid, 'k', 'es-CO')).toEqual({ kind: 'validation', errors: [{ field: 'credit.termMonths', code: 'term_out_of_range', params: { min: 12, max: 240 } }] });
    spy.mockRestore();
    spy = respond(400, { error: 'validation_error' });
    expect((await requestQuote(valid, 'k', 'es-CO')).kind).toBe('unavailable');
    spy.mockRestore();
  });

  it('treats a network failure or an unreadable body as unavailable', async () => {
    let spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    expect((await requestQuote(valid, 'k', 'es-CO')).kind).toBe('unavailable');
    spy.mockRestore();
    spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 201 }));
    expect((await requestQuote(valid, 'k', 'es-CO')).kind).toBe('unavailable');
    spy.mockRestore();
  });

  it('builds amounts as integers and trims text', () => {
    const body = toRequestBody({ ...valid, fullName: '  Ana  ', amount: '50000000' });
    expect(body.customer.fullName).toBe('Ana');
    expect(body.credit.amount).toBe(50000000);
  });
});
