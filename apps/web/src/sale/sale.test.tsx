import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { AdvisorSale } from './AdvisorSale';
import { CustomerSalePortal } from './CustomerSale';
import { clearPurchaseDraft, savePurchaseDraft } from '../offer/purchase-draft';

const traceId = '33333333-3333-4333-8333-333333333333';
const reference = '22222222-2222-4222-8222-222222222222';
const authorizationId = '44444444-4444-4444-8444-444444444444';
const offerId = '55555555-5555-4555-8555-555555555555';
const authorization = { authorizationId, advisorReference: reference, operation: 'advisor-sale:prepare', grantedAt: '2026-11-11T00:00:00.000Z', expiresAt: '2026-11-12T00:00:00.000Z', revokedAt: null, status: 'active' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify({ ...value as object, traceId }), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the customer authorizes an advisor only after confirming, lists it and revokes it', async () => {
  let items: unknown[] = [];
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/revoke')) { items = [{ ...authorization, status: 'revoked', revokedAt: '2026-11-11T01:00:00.000Z' }]; return json(items[0] as object); }
      items = [authorization]; return json(authorization, 201);
    }
    return json({ items });
  }));
  const { container } = render(<I18n><CustomerSalePortal onSessionLost={() => {}} /></I18n>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Autorizar a un asesor' }));
  await screen.findByText('Sin autorizaciones.');
  const button = screen.getByRole('button', { name: 'Autorizar' });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Referencia del asesor'), { target: { value: reference } });
  expect(button).toBeDisabled();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Autorizo a este asesor a preparar una cotización y una oferta a mi nombre'));
  await user.click(button);
  expect((await screen.findAllByText(/Activa/)).length).toBeGreaterThan(0);
  expect(posts[0]).toEqual({ url: '/api/v1/me/advisor-sale-authorizations', body: { advisorReference: reference, validityDays: 1 } });
  expect(screen.getByText(authorizationId)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Revocar' }));
  expect((await screen.findAllByText(/Revocada/)).length).toBeGreaterThan(0);
  expect(posts[1].url).toBe(`/api/v1/me/advisor-sale-authorizations/${authorizationId}/revoke`);
  expect(screen.queryByRole('button', { name: 'Revocar' })).not.toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});

it('an unknown advisor reference is reported without creating anything', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? json({ error: 'advisor_not_found' }, 404) : json({ items: [] })));
  render(<I18n><CustomerSalePortal onSessionLost={() => {}} /></I18n>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Autorizar a un asesor' }));
  await screen.findByText('Sin autorizaciones.');
  const user = userEvent.setup();
  fireEvent.change(screen.getByLabelText('Referencia del asesor'), { target: { value: reference } });
  await user.click(screen.getByLabelText('Autorizo a este asesor a preparar una cotización y una oferta a mi nombre'));
  await user.click(screen.getByRole('button', { name: 'Autorizar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se encontró el registro.');
  expect(screen.getByText('Sin autorizaciones.')).toBeInTheDocument();
});

it('the customer opens the offer an advisor prepared without creating another one, and cannot open a foreign one', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push((init?.method ?? 'GET') + ' ' + url);
    if (url === '/api/v1/me/advisor-sale-authorizations') return json({ items: [] });
    if (url === `/api/v1/offers/${offerId}`) return json({ offerId, offerVersion: 1, quoteId: 'COT-2026-00001', product: 'vida_hipotecario', status: 'definitive', premium: '120000.0000', currency: 'COP',
      coverage: { kind: 'mortgage_life', sumInsured: '200000000.0000' }, effectiveFrom: '2026-11-12T00:00:00.000Z', effectiveUntil: '2036-11-12T00:00:00.000Z', expiresAt: '2099-11-12T00:00:00.000Z',
      ruleVersion: 'academic-mortgage-1', synthetic: true });
    return json({ error: 'not_found' }, 404);
  }));
  render(<I18n><CustomerSalePortal onSessionLost={() => {}} /></I18n>);
  const user = userEvent.setup();
  expect(screen.queryByLabelText('Código de la oferta')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Referencia del asesor')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Continuar una oferta preparada' }));
  expect(screen.getByRole('heading', { name: 'Continuar una oferta preparada' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Volver a Mi asesor' }));
  expect(screen.getByRole('heading', { name: 'Mi asesor' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Continuar una oferta preparada' }));
  expect(requests).not.toContain('GET /api/v1/me/advisor-sale-authorizations');
  fireEvent.change(screen.getByLabelText('Código de la oferta'), { target: { value: '66666666-6666-4666-8666-666666666666' } });
  await user.click(screen.getByRole('button', { name: 'Revisar oferta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No encontramos una oferta tuya con ese código.');
  fireEvent.change(screen.getByLabelText('Código de la oferta'), { target: { value: offerId } });
  await user.click(screen.getByRole('button', { name: 'Revisar oferta' }));
  await waitFor(() => expect(screen.queryByLabelText('Código de la oferta')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Autorizar a un asesor' })).not.toBeInTheDocument());
  expect(requests.some(request => request.startsWith('POST'))).toBe(false);
  expect(requests).toContain(`GET /api/v1/offers/${offerId}`);
  expect(requests.some(request => request.includes('/quotes/'))).toBe(false);
});

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillSale = () => {
  fill('Código de autorización', authorizationId); fill('Nombre completo del cliente', 'Ana Prueba'); fill('Número de documento (CC)', '1000000001');
  fill('Fecha de nacimiento', '1990-05-17'); fill('Ciudad', 'Bogota'); fill('Identificador del crédito (opcional)', 'CR-1'); fill('Monto del crédito (COP)', '200000000');
};

it('the advisor prepares the offer, retries with the same key and shows only what the customer needs to continue', async () => {
  const keys: (string | null)[] = []; const bodies: unknown[] = []; let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/v1/advisor/offers');
    keys.push(new Headers(init?.headers).get('idempotency-key')); bodies.push(JSON.parse(String(init?.body)));
    attempts += 1;
    if (attempts === 1) return json({ error: 'financial_unavailable' }, 503);
    return json({ offerId, quoteId: 'COT-2026-00001', status: 'definitive', contractable: true, premium: '120000.0000', currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: '200000000.0000' },
      validity: { effectiveFrom: '2026-11-12T00:00:00.000Z', effectiveUntil: '2036-11-12T00:00:00.000Z', expiresAt: '2026-11-12T00:00:00.000Z' }, signals: [], explanation: {}, synthetic: true }, 201);
  }));
  const { container } = render(<I18n><AdvisorSale onSessionLost={() => {}} /></I18n>);
  fillSale();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se confirmó la operación.');
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Oferta definitiva preparada');
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual({ authorizationId, product: 'vida_hipotecario', customer: { fullName: 'Ana Prueba', documentType: 'CC', documentNumber: '1000000001', birthDate: '1990-05-17', city: 'Bogota' },
    credit: { partnerCreditId: 'CR-1', amount: 200000000, termMonths: 120 } });
  expect(screen.getByText(offerId)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Código de la oferta');
  expect(await axe(container)).toHaveNoViolations();
  fill('Monto del crédito (COP)', '300000000');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  await waitFor(() => expect(keys).toHaveLength(3));
  expect(keys[2]).not.toBe(keys[0]);
});

it('every refusal of the advisor operation is explained and consent is told apart from permission', async () => {
  const reply = vi.fn(async () => json({ error: 'forbidden' }, 403));
  vi.stubGlobal('fetch', reply);
  render(<I18n><AdvisorSale onSessionLost={() => {}} /></I18n>);
  fillSale();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso vigente para esta operación.');
  reply.mockImplementation(async () => json({ error: 'consent_required' }, 403));
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/autorización de datos/));
  reply.mockImplementation(async () => json({ error: 'idempotency_key_reused' }, 409));
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('La solicitud ya se usó'));
  expect(screen.queryByText(/Entrega este código/)).not.toBeInTheDocument();
});

it('a reload during the purchase of an assisted offer resumes at its policy instead of the authorization screen', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return json({ error: 'policy_pending' }, 404); }));
  expect(savePurchaseDraft({ quoteId: 'COT-2026-00001', issue: null, acceptance: { acceptanceId: '77777777-7777-4777-8777-777777777777', offerId, acceptedAt: '2026-11-11T00:00:00.000Z', traceId } })).toBe(true);
  try {
    render(<I18n><CustomerSalePortal onSessionLost={() => {}} /></I18n>);
    await waitFor(() => expect(requests.some(url => url.includes('/policies/by-acceptance/77777777-7777-4777-8777-777777777777/policy'))).toBe(true));
    expect(screen.queryByLabelText('Referencia del asesor')).not.toBeInTheDocument();
  } finally { clearPurchaseDraft(); }
});


it('the advisor can leave the credit identifier empty and a stable one is sent on retry', async () => {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(String(init.body)); return json({ error: 'unavailable' }, 503); }
    return json({ error: 'not_found' }, 404);
  }));
  render(<I18n><AdvisorSale onSessionLost={() => {}} /></I18n>);
  fill('Código de autorización', authorizationId); fill('Nombre completo del cliente', 'Ana Prueba'); fill('Número de documento (CC)', '1000000001');
  fill('Fecha de nacimiento', '1990-05-17'); fill('Ciudad', 'Bogota'); fill('Monto del crédito (COP)', '200000000');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: 'Preparar oferta' }));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(JSON.parse(posts[0]).credit.partnerCreditId).toMatch(/^ASE-[0-9A-F]{12}$/);
  expect(posts[1]).toBe(posts[0]);
});
