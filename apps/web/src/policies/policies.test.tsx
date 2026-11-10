import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { PolicyPortal } from './PolicyPortal';

const traceId = '50000000-0000-4000-8000-000000000001';
const policyId = '10000000-0000-4000-8000-000000000001';
const flightId = '10000000-0000-4000-8000-000000000002';
const json = (body: unknown, status = 200) => new Response(JSON.stringify({ ...(body as object), traceId }), { status, headers: { 'content-type': 'application/json' } });
const summary = { policyId, product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP', effectiveFrom: '2026-10-15T00:00:00.000Z',
  effectiveUntil: '2027-10-15T00:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' } };
const flight = { ...summary, policyId: flightId, product: 'flight_delay', premium: '10000.0000', effectiveUntil: '2026-12-01T00:00:00.000Z',
  coverage: { kind: 'flight_delay', flightReference: '20000000-0000-4000-8000-000000000001', thresholdMinutes: 180, payoutAmount: '100000.0000' } };
const detail = { ...summary, exclusions: [{ code: '7.1', text: 'Actos intencionales del asegurado dirigidos a producir el siniestro.' }, { code: '7.2', text: 'Participación en actividades bélicas.' }],
  conditionsVersion: 'academic-conditions-1',
  documents: [{ documentId: 'signed_policy', issuedAt: '2026-10-15T00:02:00.000Z' }, { documentId: 'general_conditions', issuedAt: '2026-10-15T00:02:00.000Z' },
    { documentId: 'premium_receipt', issuedAt: '2026-10-15T00:01:30.000Z' }],
  payments: [{ date: '2026-10-15T00:01:30.000Z', amount: '86400.0000', currency: 'COP', status: 'paid', reference: 'MOCK-30000000-0000-4000-8000-000000000001' }] };
const lost = vi.fn();
const show = (english = false) => render(<I18n initial={english ? 'en-US' : 'es-CO'}><PolicyPortal onSessionLost={lost} /></I18n>);
function serve(routes: Record<string, () => Response | Promise<Response>>) {
  const fetch = vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) throw new Error('unexpected ' + url);
    return route();
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); lost.mockClear(); });

describe('my policies', () => {
  it('lists the issued policies with product, status, validity and premium, and opens one', async () => {
    const fetch = serve({ '/api/v1/policies/issued': () => json({ policies: [summary, flight], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail) });
    show(); const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Mis pólizas' })).toHaveFocus();
    expect(fetch).toHaveBeenCalledWith('/api/v1/policies/issued', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    const cards = screen.getAllByRole('button', { name: /^Ver detalle de/ });
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('Vida hipotecario')).toBeVisible();
    expect(within(cards[0]).getByText('Vigente')).toBeVisible();
    expect(within(cards[0]).getByText(/86\.400/)).toBeVisible();
    expect(within(cards[1]).getByText('Retraso de vuelo')).toBeVisible();
    await user.click(cards[0]);
    expect(await screen.findByRole('tab', { name: 'Información', selected: true })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Vida hipotecario' })).toHaveFocus();
  });

  it('shows the coverage and the exclusions of the policy', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [summary], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail) });
    show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    expect(within(coverage).getByText('Suma asegurada').nextSibling).toHaveTextContent(/320\.000\.000/);
    expect(within(coverage).getByText('Prima (pago único)')).toBeVisible();
    const exclusions = screen.getByRole('region', { name: 'Exclusiones' });
    expect(within(exclusions).getAllByRole('listitem')).toHaveLength(2);
    expect(within(exclusions).getByText('Actos intencionales del asegurado dirigidos a producir el siniestro.')).toBeVisible();
    expect(within(exclusions).getByText(/academic-conditions-1/)).toBeVisible();
  });

  it('shows the flight coverage with its delay threshold and payout', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [flight], hasMore: false }), [`/api/v1/policies/${flightId}/detail`]: () => json({ ...detail, ...flight }) });
    show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    expect(within(coverage).getByText('180 minutos')).toBeVisible();
    expect(within(coverage).getByText('Pago por retraso').nextSibling).toHaveTextContent(/100\.000/);
  });

  it('lists the documents with their issue date and downloads one as a PDF', async () => {
    const pdf = new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="signed-policy-10000000.pdf"' } });
    const fetch = serve({ '/api/v1/policies/issued': () => json({ policies: [summary], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail),
      [`/api/v1/policies/${policyId}/documents/signed_policy`]: () => pdf });
    const createObjectURL = vi.fn(() => 'blob:synthetic'), revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('signed-policy-10000000.pdf'); });
    show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    await user.click(await screen.findByRole('tab', { name: 'Documentos' }));
    const documents = screen.getByRole('region', { name: 'Documentos' });
    expect(within(documents).getAllByRole('listitem').map(item => within(item).getByRole('strong').textContent)).toEqual(['Póliza firmada', 'Condiciones generales', 'Comprobante de pago']);
    expect(within(documents).getAllByText(/^Emitido /)).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Descargar PDF: Póliza firmada' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(`/api/v1/policies/${policyId}/documents/signed_policy`, expect.objectContaining({ method: 'GET' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('reports a failed download without saving anything', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [summary], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail),
      [`/api/v1/policies/${policyId}/documents/premium_receipt`]: () => json({ error: 'financial_unavailable' }, 503) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    await user.click(await screen.findByRole('tab', { name: 'Documentos' }));
    await user.click(screen.getByRole('button', { name: 'Descargar PDF: Comprobante de pago' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo descargar el documento');
    expect(click).not.toHaveBeenCalled();
  });

  it('shows the premium payment history with date, amount, status and reference', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [summary], hasMore: false }),
      [`/api/v1/policies/${policyId}/detail`]: () => json({ ...detail, payments: [...detail.payments, { date: '2026-10-14T00:00:00.000Z', amount: '86400.0000', currency: 'COP', status: 'failed', reference: null }] }) });
    show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    await user.click(await screen.findByRole('tab', { name: 'Historial' }));
    const rows = within(screen.getByRole('table', { name: 'Pagos de la prima' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Pagado')).toBeVisible();
    expect(within(rows[0]).getByText(/86\.400/)).toBeVisible();
    expect(within(rows[0]).getByText('MOCK-30000000-0000-4000-8000-000000000001')).toBeVisible();
    expect(within(rows[1]).getByText('Fallido')).toBeVisible();
    expect(within(rows[1]).getByText('Sin referencia')).toBeVisible();
  });

  it('moves between the tabs with the arrow keys and returns to the list', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [summary], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail) });
    show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    const info = await screen.findByRole('tab', { name: 'Información' });
    info.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Documentos', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Historial', selected: true })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /Mis pólizas/ }));
    expect(await screen.findByRole('heading', { name: 'Mis pólizas' })).toBeVisible();
  });

  it('offers a quote when there are no issued policies', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [], hasMore: false }) });
    show();
    expect(await screen.findByText('Aún no tienes pólizas emitidas.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Cotizar un seguro' })).toHaveAttribute('href', '/cotizar');
  });

  it('retries after a technical failure and reports a lost session', async () => {
    let calls = 0;
    serve({ '/api/v1/policies/issued': () => (++calls === 1 ? json({ error: 'financial_unavailable' }, 503) : json({ policies: [summary], hasMore: false })) });
    show(); const user = userEvent.setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar tus pólizas.');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: /^Ver detalle de/ })).toBeVisible();
    expect(lost).not.toHaveBeenCalled();
  });

  it('asks to sign in again when the session cannot be renewed', async () => {
    serve({ '/api/v1/policies/issued': () => json({ error: 'unauthorized' }, 401), '/auth/session': () => new Response(null, { status: 401 }) });
    show();
    await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció');
  });

  it('rejects a response that does not match the contract instead of rendering it', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [{ ...summary, premium: 86400 }], hasMore: false }) });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar tus pólizas.');
  });

  it('rejects a flight coverage whose delay threshold is below the contractual minimum', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [{ ...flight, coverage: { ...flight.coverage, thresholdMinutes: 0 } }], hasMore: false }) });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar tus pólizas.');
  });

  it('marks an expired policy and works in English', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [{ ...summary, effectiveUntil: '2026-11-01T00:00:00.000Z' }], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail) });
    show(true); const user = userEvent.setup();
    const card = await screen.findByRole('button', { name: /^View details of/ });
    expect(within(card).getByText('Expired')).toBeVisible();
    await user.click(card);
    expect(await screen.findByRole('tab', { name: 'Information' })).toBeVisible();
    expect(screen.getByText(/The contract text is shown in Spanish/)).toBeVisible();
  });

  it('has no detectable accessibility violations in the list or in each tab', async () => {
    serve({ '/api/v1/policies/issued': () => json({ policies: [summary], hasMore: false }), [`/api/v1/policies/${policyId}/detail`]: () => json(detail) });
    const { container } = show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Ver detalle de/ }));
    await screen.findByRole('tab', { name: 'Información' });
    for (const name of ['Información', 'Documentos', 'Historial']) {
      await user.click(screen.getByRole('tab', { name }));
      expect(await axe(container)).toHaveNoViolations();
    }
  });
});
