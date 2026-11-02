import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { AuditWorkspace } from './AuditWorkspace';
import { getAuditDecision, listAuditDecisions } from './api';
import examples from '../../../../packages/contracts/examples/underwriting-audit.json';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const traceId = examples.detail.traceId;
const id = examples.detail.decision.decisionId;
const lost = vi.fn();
const show = (english = false) => render(<I18n initial={english ? 'en-US' : 'es-CO'}><AuditWorkspace onSessionLost={lost} /></I18n>);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); lost.mockClear(); });
describe('protected underwriting audit workspace', () => {
  it('lists decisions, applies filters, opens captured facts and rule checks and returns to the list', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => response(url.includes('/' + id) ? examples.detail : examples.page));
    vi.stubGlobal('fetch', fetch); show(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: id }));
    expect(await screen.findByRole('heading', { name: 'Entradas conservadas' })).toBeVisible();
    expect(screen.getByText('8.000.000')).toBeVisible(); expect(screen.getByText('Puntaje mínimo de 600')).toBeVisible();
    expect(screen.getByText('No se utilizó modelo')).toBeVisible();
    expect(screen.getByText('CNS-2026-00001 / 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Volver a decisiones/ }));
    await screen.findByRole('button', { name: id });
    await user.type(screen.getByLabelText('ID de decisión, oferta o cotización'), 'COT-2026-00001');
    await user.selectOptions(screen.getByLabelText('Resultado'), 'declined');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/v1/underwriting-decisions?reference=COT-2026-00001&outcome=declined', expect.objectContaining({ cache: 'no-store' })));
    await user.click(await screen.findByRole('button', { name: id }));
    await screen.findByRole('heading', { name: 'Entradas conservadas' });
    await user.click(screen.getByRole('button', { name: /Volver a decisiones/ }));
    expect(screen.getByLabelText('ID de decisión, oferta o cotización')).toHaveValue('COT-2026-00001');
    expect(screen.getByLabelText('Resultado')).toHaveValue('declined');
    await user.selectOptions(screen.getByLabelText('Producto'), 'flight_delay');
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-31' } });
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await user.click(await screen.findByRole('button', { name: id }));
    await screen.findByRole('heading', { name: 'Entradas conservadas' });
    await user.click(screen.getByRole('button', { name: /Volver a decisiones/ }));
    expect(screen.getByLabelText('Producto')).toHaveValue('flight_delay');
    expect(screen.getByLabelText('Desde')).toHaveValue('2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    for (const label of ['ID de decisión, oferta o cotización', 'Producto', 'Resultado', 'Desde', 'Hasta']) expect(screen.getByLabelText(label)).toHaveValue('');
    await screen.findByRole('button', { name: id });
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/v1/underwriting-decisions', expect.anything()));

  });
  it('shows incomplete historical captures without filling absent facts', async () => {
    const { identityVerified: _identity, ...inputs } = examples.detail.decision.inputs;
    const detail = { ...examples.detail, decision: { ...examples.detail.decision, inputs, reconstruction: { status: 'incomplete_capture', missing: ['inputs.identityVerified'] } } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(examples.page)).mockResolvedValue(response(detail)));
    show(); await userEvent.click(await screen.findByRole('button', { name: id }));
    expect(await screen.findByText('Captura histórica incompleta')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Datos faltantes' })).toBeVisible();
    expect(screen.queryByText('Coincide con la regla conservada')).toBeNull();
  });
  it('handles empty results and supports the English catalogue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [], next: null, traceId })));
    show(true); expect(await screen.findByText('No decisions match these filters.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Underwriting decisions' })).toBeVisible();
  });
  it('clears protected data when permission is revoked while reading a detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(examples.page)).mockResolvedValue(response({ error: 'forbidden', traceId }, 403)));
    show(); await userEvent.click(await screen.findByRole('button', { name: id }));
    expect(await screen.findByText('Tu cuenta no tiene permiso de auditoría.')).toBeVisible();
    expect(screen.queryByText('8.000.000')).toBeNull(); expect(screen.queryByRole('button', { name: 'Exportar JSON' })).toBeNull();
  });
  it('notifies the shell after session renewal fails without retaining historical facts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'unauthorized', traceId }, 401)));
    show(); await waitFor(() => expect(lost).toHaveBeenCalledOnce());
    expect(screen.getByText('La sesión venció. Inicia sesión de nuevo.')).toBeVisible();
  });
  it('ignores a late detail response after navigating back, even if transport ignores abort', async () => {
    let resolve: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(examples.page)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; })).mockResolvedValue(response(examples.page)));
    show(); await userEvent.click(await screen.findByRole('button', { name: id }));
    await userEvent.click(screen.getByRole('button', { name: /Volver a decisiones/ }));
    await screen.findByRole('button', { name: id });
    await act(async () => resolve(response(examples.detail)));
    expect(screen.queryByRole('heading', { name: 'Entradas conservadas' })).toBeNull();
  });
  it('rechecks permission before export and does not download when access is revoked', async () => {
    const create = vi.fn(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(examples.page)).mockResolvedValueOnce(response(examples.detail)).mockResolvedValue(response({ error: 'forbidden', traceId }, 403)));
    show(); await userEvent.click(await screen.findByRole('button', { name: id }));
    await userEvent.click(await screen.findByRole('button', { name: 'Exportar JSON' }));
    expect(await screen.findByText('Tu cuenta no tiene permiso de auditoría.')).toBeVisible(); expect(create).not.toHaveBeenCalled();
  });
  it('purges data when the tab is hidden and reauthorizes when visible', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(examples.page)).mockResolvedValue(response({ error: 'forbidden', traceId }, 403)); vi.stubGlobal('fetch', fetch);
    show(); await screen.findByRole('button', { name: id });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByRole('button', { name: id })).toBeNull();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText('Tu cuenta no tiene permiso de auditoría.')).toBeVisible();
  });
  it('has no serious accessibility violations in the list and detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => response(url.endsWith(id) ? examples.detail : examples.page)));
    const view = show(); await screen.findByRole('button', { name: id });
    expect(await axe(view.container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole('button', { name: id })); await screen.findByRole('heading', { name: 'Entradas conservadas' });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
describe('audit HTTP response boundary', () => {
  it('rejects malformed success responses and a detail for another decision', async () => {
    for (const body of [{ ...examples.detail, decision: { ...examples.detail.decision, decisionId: examples.detail.traceId } }, { ...examples.detail, decision: { ...examples.detail.decision, sources: [{}] } }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      expect((await getAuditDecision(id, new AbortController().signal)).kind).toBe('unavailable');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [null], next: null, traceId })));
    expect((await listAuditDecisions(new URLSearchParams(), new AbortController().signal)).kind).toBe('unavailable');
  });
});
