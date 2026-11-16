import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { ReportsWorkspace } from './ReportsWorkspace';
import examples from '../../../../packages/contracts/examples/reports.json';

const response = (body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const traceId = examples.page.traceId;
const sent = examples.page.items[0];
const unsent = { ...sent, reportId: '90000000-0000-4000-8000-000000000002', destination: 'reinsurer' as const, delivery: undefined };
const page = { items: [sent, unsent], next: null, traceId };
const lost = vi.fn();
const show = (english = false) => render(<I18n initial={english ? 'en-US' : 'es-CO'}><ReportsWorkspace onSessionLost={lost} /></I18n>);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); lost.mockClear(); });

describe('protected reports workspace', () => {
  it('lists each revision with its hash, rows and delivery state, and an unsent one has no delivery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(page)));
    show();
    const table = await screen.findByRole('table', { name: 'Reportes al regulador y la reaseguradora' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Regulador')).toBeVisible();
    expect(within(rows[0]).getByText('Revisión 1')).toBeVisible();
    expect(within(rows[0]).getByText(sent.contentHash.slice(0, 12))).toBeVisible();
    expect(within(rows[0]).getByText('Acuse recibido')).toBeVisible();
    expect(within(rows[0]).getByRole('button', { name: 'Reintentar envío' })).toBeDisabled();
    expect(within(rows[1]).getByText('Sin enviar')).toBeVisible();
    expect(within(rows[1]).getByRole('button', { name: 'Enviar' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Reportes al regulador y la reaseguradora' })).toHaveFocus();
  });

  it('generates with only the month, the destination and the format, and tells whether the revision is new', async () => {
    const fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response({ ...examples.generated, created: false }) : response(page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await screen.findByRole('table');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Destino' }), 'reinsurer');
    await user.click(screen.getByRole('button', { name: 'Generar' }));
    const call = fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(call?.[0]).toBe('/api/v1/reports');
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ period: expect.stringMatching(/^\d{4}-\d{2}$/), destination: 'reinsurer', format: 'csv' });
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('El contenido no cambió: es la revisión R1.');
  });

  it('never shows an unanswered delivery as a success and lets the operator retry it', async () => {
    const answers = [examples.uncertainDelivery, { ...examples.uncertainDelivery, delivery: { ...examples.uncertainDelivery.delivery, status: 'acknowledged', reference: examples.page.items[0].delivery.reference } }];
    const fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response(answers.shift()) : response(page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    const row = within(await screen.findByRole('table')).getAllByRole('row')[2];
    await user.click(within(row).getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El destino no respondió a tiempo. Reintenta para consultar su estado.');
    expect(fetch).toHaveBeenCalledWith(`/api/v1/reports/${unsent.reportId}/delivery`, expect.objectContaining({ method: 'POST', body: '{}' }));
    await waitFor(() => expect(screen.queryByText('Acuse recibido', { selector: '.reports-delivery-uncertain' })).toBeNull());
  });

  it('shows a rejection with the destination code', async () => {
    const rejected = { ...page, items: [{ ...sent, delivery: { ...sent.delivery, status: 'rejected', reference: null, rejectionCode: 'totals_mismatch' } }] };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(rejected)));
    show();
    const row = within(await screen.findByRole('table')).getAllByRole('row')[1];
    expect(within(row).getByText('Rechazado')).toBeVisible();
    expect(within(row).getByText('Motivo: totals_mismatch')).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Reintentar envío' })).toBeDisabled();
  });

  it('downloads through the authorized route and shows the failure instead of a JSON page', async () => {
    const calls: string[] = [];
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/download?file=manifest')) return response({ error: 'integrity_violation', traceId }, 409);
      if (url.includes('/download')) return response('record_type\n', 200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="regulator-2026-11-r1.csv"' });
      return response(page);
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:report'), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    show(); const user = userEvent.setup();
    const row = within(await screen.findByRole('table')).getAllByRole('row')[1];
    await user.click(within(row).getByRole('button', { name: 'Descargar CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(calls).toContain(`/api/v1/reports/${sent.reportId}/download?file=csv`);
    await user.click(within(row).getByRole('button', { name: 'Descargar manifiesto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El archivo guardado no coincide con su huella. No se entregó.');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('explains a missing grant without offering a retry, and signs the operator out when the session is gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(examples.forbidden, 403)));
    const denied = show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu cuenta no tiene permiso para esta operación de reportes.');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    denied.unmount();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url.startsWith('/auth/session') ? response({}, 401) : response({ error: 'unauthorized', traceId }, 401)));
    show();
    await waitFor(() => expect(lost).toHaveBeenCalled());
  });

  it('offers a retry when the list is unavailable and an empty state without reports', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response({ error: 'service_unavailable', traceId }, 503)));
    const failing = show();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la operación de reportes.');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    failing.unmount();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(examples.emptyPage)));
    show();
    expect(await screen.findByText('Aún no hay reportes.')).toBeVisible();
  });

  it('filters by destination on the server', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Reaseguradora' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/v1/reports?destination=reinsurer', expect.anything()));
  });

  it('keeps English copy and passes the accessibility check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(page)));
    const { container } = show(true);
    expect(await screen.findByRole('table', { name: 'Regulator and reinsurer reports' })).toBeVisible();
    expect(screen.getByText('Acknowledged')).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
});
