import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from '../App';
import { I18n } from '../i18n/I18n';
import { SUPPORTED_TERMS } from '../consent/wording';
import { LiveRegion } from './Live';
import { PublicQuoteFlow } from './PublicQuoteFlow';
import { clearEstimateDraft, readEstimateDraft, saveEstimateDraft } from './estimate-draft';
import { requestEstimate } from './estimate-api';

const values = { ageYears: '34', amount: '320000000', termMonths: '180' };
const result = { premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000, termMonths: 180, basis: 'minimum_data', ruleVersion: 'provisional-1', traceId: '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.restoreAllMocks());

async function fill(user: ReturnType<typeof userEvent.setup>) {
  for (const [label, value] of [[/Edad/, values.ageYears], [/Monto/, values.amount], [/Plazo/, values.termMonths]] as const) await user.type(screen.getByLabelText(label), value);
}

describe('public estimate and sign-in handoff', () => {
  it('also preserves complete inputs through the header sign-in link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 401));
    const user = userEvent.setup();
    render(<App />);
    await fill(user);
    const link = screen.getByRole('link', { name: 'Ingresa a Solventa' });
    link.addEventListener('click', event => event.preventDefault());
    await user.click(link);
    expect(readEstimateDraft()).toEqual(values);
  });

  it('explains blocked storage before allowing a handoff without retained inputs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async path => String(path) === '/auth/session' ? json({}, 401) : json(result));
    const user = userEvent.setup();
    render(<App />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Calcular estimación' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar con esta estimación' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    await user.click(screen.getByRole('link', { name: 'Iniciar sesión o crear cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El navegador no permitió conservar los datos.');
    expect(screen.getByRole('link', { name: 'Iniciar sesión sin conservar los datos' })).toHaveAttribute('href', '/auth/login');
  });

  it.each([false, true])('keeps inputs when a slow authenticated session check resolves (retry: %s)', async retry => {
    let finish: ((response: Response) => void) | undefined;
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      if (retry && calls === 1) return json({}, 503);
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const user = userEvent.setup();
    render(<App />);
    if (retry) {
      await screen.findByText('No pudimos comprobar tu sesión.');
      await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    }
    await fill(user);
    await act(async () => { finish?.(json({}, 200)); });
    await screen.findByLabelText(/Nombre completo/);
    expect(screen.getByLabelText(/Monto/)).toHaveValue('320000000');
    expect(screen.getByLabelText(/Plazo/)).toHaveValue('180');
    expect(screen.getByText(/Retomamos tu estimación para 34 años/)).toBeVisible();
  });

  it('offers an accessible calculator before login and explains sign-in separately from consent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async path => String(path) === '/auth/session' ? json({}, 401) : json(result));
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('button', { name: 'Calcular estimación' });
    expect(screen.queryByLabelText(/Documento/)).toBeNull();
    expect(screen.queryByLabelText(/Nombre completo/)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Calcular estimación' }));
    expect(await screen.findByRole('heading', { name: 'Tu estimación preliminar' })).toHaveFocus();
    expect(screen.getByText(/No es una oferta ni permite contratar/)).toBeVisible();
    const call = fetchMock.mock.calls.find(([path]) => String(path) === '/api/v1/quote-estimates');
    expect(call?.[1]?.credentials).toBe('omit');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ ageYears: 34, amount: 320000000, termMonths: 180 });
    await user.click(screen.getByRole('button', { name: 'Continuar con esta estimación' }));
    expect(screen.getByRole('heading', { name: 'Inicia sesión para continuar' })).toHaveFocus();
    expect(screen.getByText(/Si ya tienes cuenta/)).toBeVisible();
    expect(screen.getByText(/Si es tu primera vez/)).toBeVisible();
    expect(screen.getByText(/Iniciar sesión no autoriza/)).toBeVisible();
    expect(screen.getByText(/Puedes rechazar la autorización/)).toBeVisible();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/consents'))).toBe(false);
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Volver a la estimación' }));
    await user.click(screen.getByRole('button', { name: 'Corregir datos' }));
    expect(screen.getByLabelText(/Edad/)).toHaveValue('34');
    expect(screen.getByLabelText(/Monto/)).toHaveValue('320000000');
  });

  it('preserves only calculator inputs across login, recalculates the saved quote and then shows explicit consent', async () => {
    let authenticated = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async path => {
      if (String(path) === '/auth/session') return json({}, authenticated ? 200 : 401);
      if (String(path) === '/api/v1/quote-estimates') return json(result);
      if (String(path) === '/api/v1/me/quotes') return json({ ...result, quoteId: 'COT-2026-00001', validUntil: '2026-11-14T15:00:00Z' }, 201);
      if (String(path) === '/api/v1/consents/terms') return json(SUPPORTED_TERMS);
      return json({}, 404);
    });
    const user = userEvent.setup();
    const first = render(<App />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Calcular estimación' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar con esta estimación' }));
    const link = screen.getByRole('link', { name: 'Iniciar sesión o crear cuenta' });
    link.addEventListener('click', event => event.preventDefault());
    await user.click(link);
    expect(readEstimateDraft()).toEqual(values);
    expect(Object.keys(JSON.parse(window.sessionStorage.getItem('solventa.estimate-draft')!)).sort()).toEqual(['ageYears', 'amount', 'savedAt', 'termMonths', 'version']);
    first.unmount();
    authenticated = true;
    render(<App />);
    await screen.findByLabelText(/Nombre completo/);
    expect(screen.getByLabelText(/Monto/)).toHaveValue('320000000');
    expect(screen.getByLabelText(/Plazo/)).toHaveValue('180');
    expect(screen.getByLabelText(/Fecha de nacimiento/)).toHaveValue('');
    expect(screen.getByText(/Retomamos tu estimación para 34 años/)).toBeVisible();
    await waitFor(() => expect(readEstimateDraft()).toBeNull());
    for (const [label, value] of [[/Nombre completo/, 'Synthetic Customer'], [/Documento/, '1000000001'], [/Fecha de nacimiento/, '1992-03-14'], [/Ciudad/, 'Bogotá']] as const) await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a autorización de datos' }));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Autorizar y continuar' })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === '/api/v1/me/quotes')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST' && String(init.body).includes('textVersion'))).toBe(false);
  });

  it('focuses invalid fields and never sends an invalid calculator request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<I18n><LiveRegion><main><PublicQuoteFlow initialValues={null} /></main></LiveRegion></I18n>);
    await user.click(screen.getByRole('button', { name: 'Calcular estimación' }));
    expect(screen.getByLabelText(/Edad/)).toHaveFocus();
    expect(screen.getByLabelText(/Edad/)).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still calculates when session checking is unavailable and retains inputs after a service failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({}, 503));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('No pudimos comprobar tu sesión.');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Calcular estimación' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Intenta de nuevo');
    expect(screen.getByLabelText(/Monto/)).toHaveValue('320000000');
  });

  it('translates the anonymous journey and access instructions', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async path => String(path) === '/auth/session' ? json({}, 401) : json(result));
    const user = userEvent.setup();
    render(<App />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: /Cambiar la interfaz a inglés/ }));
    await user.click(screen.getByRole('button', { name: 'Calculate estimate' }));
    await user.click(await screen.findByRole('button', { name: 'Continue with this estimate' }));
    expect(screen.getByText(/Signing in does not authorize/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  });

  it('rejects a malformed or mismatched server result instead of displaying its price', async () => {
    for (const body of [{ ...result, premiumMonthly: -1 }, { ...result, sumInsured: 1 }, { ...result, basis: 'open_finance' }, { ...result, traceId: 'bad' }, []]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(body));
      expect(await requestEstimate(values)).toEqual({ kind: 'unavailable' });
      vi.restoreAllMocks();
    }
  });

  it('expires, validates and clears drafts without trusting a stored price or identity', () => {
    expect(saveEstimateDraft(values)).toBe(true);
    expect(readEstimateDraft(Date.now() + 31 * 60 * 1000)).toBeNull();
    window.sessionStorage.setItem('solventa.estimate-draft', '{bad json');
    expect(readEstimateDraft()).toBeNull();
    window.sessionStorage.setItem('solventa.estimate-draft', JSON.stringify({ version: 1, savedAt: Date.now(), ageYears: '17', amount: '1', termMonths: '12' }));
    expect(readEstimateDraft()).toBeNull();
    saveEstimateDraft(values);
    clearEstimateDraft();
    expect(readEstimateDraft()).toBeNull();
  });
});
