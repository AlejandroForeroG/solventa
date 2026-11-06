import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { ClaimsInbox } from './ClaimsInbox';
import examples from '../../../../packages/contracts/examples/claims.json';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const traceId = examples.page.traceId;
const first = examples.page.items[0];
const lost = vi.fn();
const show = (english = false) => render(<I18n initial={english ? 'en-US' : 'es-CO'}><ClaimsInbox onSessionLost={lost} /></I18n>);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); lost.mockClear(); });

describe('protected claims inbox', () => {
  it('lists open claims in the order received with state, age, amount, evidence and priority', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(examples.page)));
    show();
    const table = await screen.findByRole('table', { name: 'Bandeja de siniestros' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('SIN-2026-01187')).toBeVisible();
    expect(within(rows[0]).getByText('En análisis')).toBeVisible();
    expect(within(rows[0]).getByText('9 días')).toHaveClass('claims-overdue');
    expect(within(rows[0]).getByText(/148\.000\.000 COP$/)).toBeVisible();
    expect(within(rows[0]).getByText('4 de 5 · incompleta')).toBeVisible();
    expect(within(rows[0]).getByText('Alta')).toBeVisible();
    expect(within(rows[1]).getByText('Escalado')).toBeVisible();
    expect(within(rows[1]).getByText('2 días')).not.toHaveClass('claims-overdue');
    expect(within(rows[2]).getByText('1 día')).toBeVisible();
    expect(within(rows[2]).getByText('Baja')).toBeVisible();
    expect(screen.getByText('Mostrando 3 siniestros')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Bandeja de siniestros' })).toHaveFocus();
  });

  it('applies each quick filter on the server and returns to every claim', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(examples.page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await screen.findByRole('table');
    expect(fetch).toHaveBeenLastCalledWith('/api/v1/claims', expect.objectContaining({ cache: 'no-store', method: 'GET' }));
    expect(screen.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
    for (const [name, url] of [['Sin asignar', '/api/v1/claims?state=unassigned'], ['Pendiente info', '/api/v1/claims?state=pending_information'], ['Vencidos', '/api/v1/claims?overdue=true'], ['Todos', '/api/v1/claims']] as const) {
      await user.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(url, expect.anything()));
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      await screen.findByRole('table');
    }
  });

  it('validates the search before asking the server and normalizes claim numbers and policy ids', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(examples.page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await screen.findByRole('table');
    const input = screen.getByLabelText('Buscar por N.º de siniestro o póliza');
    const calls = fetch.mock.calls.length;
    await user.type(input, 'siniestro uno'); await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('SIN-AAAA-NNNNN');
    expect(input).toHaveAttribute('aria-invalid', 'true'); expect(fetch.mock.calls.length).toBe(calls);
    await user.clear(input); await user.type(input, 'sin-2026-01187'); await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/v1/claims?query=SIN-2026-01187', expect.anything()));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(input); await user.type(input, first.policyId.toUpperCase()); await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(`/api/v1/claims?query=${first.policyId}`, expect.anything()));
  });

  it('pages with the cursor and keeps the active filter', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(examples.page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Vencidos' }));
    await user.click(await screen.findByRole('button', { name: 'Siguientes' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(`/api/v1/claims?overdue=true&before=${examples.page.next}`, expect.anything()));
    await user.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/v1/claims', expect.anything()));
  });

  it('explains an empty filtered result and offers to clear the filter', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => response(url === '/api/v1/claims' ? examples.page : examples.emptyPage));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Vencidos' }));
    expect(await screen.findByText('Ningún siniestro coincide con el filtro «Vencidos»')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Quitar filtro' }));
    expect(await screen.findByRole('table')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says plainly that the queue is empty when no filter is active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(examples.emptyPage)));
    show();
    expect(await screen.findByText('No hay siniestros abiertos.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Quitar filtro' })).toBeNull(); expect(screen.queryByRole('table')).toBeNull();
  });

  it('handles access denied, an expired session, a technical failure and a payload that breaks the contract without showing data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(examples.forbidden, 403)));
    const denied = show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu cuenta no tiene permiso para consultar siniestros.');
    expect(screen.queryByRole('table')).toBeNull(); expect(screen.getByText(examples.forbidden.traceId)).toBeVisible();
    denied.unmount();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response({ error: 'unauthorized', traceId }, 401)));
    const expired = show();
    expect(await screen.findByRole('alert')).toHaveTextContent('La sesión venció'); expect(lost).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expired.unmount();
    const broken = { ...examples.page, items: [{ ...first, estimatedAmount: '148000000' }] };
    for (const body of [{ error: 'service_unavailable', traceId }, broken, { ...examples.page, traceId: undefined }]) {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(body, 'items' in body ? 200 : 503)));
      const view = show();
      expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar la bandeja de siniestros.');
      expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByText('SIN-2026-01187')).toBeNull();
      view.unmount();
    }
    const fetch = vi.fn().mockImplementationOnce(async () => response({ error: 'service_unavailable', traceId }, 503)).mockImplementation(async () => response(examples.page));
    vi.stubGlobal('fetch', fetch); show();
    await userEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('ignores a slow answer that arrives after a newer request', async () => {
    let release: (value: Response) => void = () => {};
    const slow = new Promise<Response>(resolve => { release = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(slow).mockImplementation(async () => response(examples.emptyPage));
    vi.stubGlobal('fetch', fetch); show();
    await userEvent.click(screen.getByRole('button', { name: 'Vencidos' }));
    expect(await screen.findByText(/Ningún siniestro coincide/)).toBeVisible();
    await act(async () => { release(response(examples.page)); await slow; });
    expect(screen.queryByRole('table')).toBeNull(); expect(screen.getByText(/Ningún siniestro coincide/)).toBeVisible();
  });

  it('renders in English with the same data and has no accessibility violations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(examples.page)));
    const { container } = show(true);
    const table = await screen.findByRole('table', { name: 'Claims inbox' });
    expect(within(table).getByText('Under review')).toBeVisible(); expect(within(table).getByText('4 of 5 · incomplete')).toBeVisible();
    expect(within(table).getByText('1 day')).toBeVisible(); expect(screen.getByText('Showing 3 claims')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Overdue' })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
});
