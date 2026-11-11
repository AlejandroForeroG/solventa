import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { PartnerPortal } from './PartnerPortal';
import example from '../../../../packages/contracts/examples/partner-portal-v2.json';

const lost = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const show = (english = false) => render(<I18n initial={english ? 'en-US' : 'es-CO'}><PartnerPortal onSessionLost={lost} /></I18n>);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); lost.mockClear(); });

it('renders actual full-period metrics, safe credentials, catalog, quota and registered versions accessibly', async () => {
  const fetch = vi.fn(async () => json(example)); vi.stubGlobal('fetch', fetch);
  const { container } = show();
  expect(await screen.findByText('synthetic-partner')).toBeVisible();
  expect(screen.getByText('Período consultado: 2026-11-01 – 2026-11-07 UTC')).toBeVisible();
  expect(screen.getByText('Solicitudes por día UTC')).toBeVisible();
  expect(screen.getByText(example.credentials[0].id)).toBeVisible();
  expect(screen.getAllByText(/Sin fecha de retiro/)).toHaveLength(2);
  expect(fetch).toHaveBeenCalledWith('/api/v2/partner-portal?from=2026-11-01&to=2026-11-07', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
  expect(await axe(container)).toHaveNoViolations();
});
it('keeps the applied period visible while draft dates are edited and uses new dates only after consultation', async () => {
  const fetch = vi.fn(async () => json(example)); vi.stubGlobal('fetch', fetch); show();
  await screen.findByText('synthetic-partner');
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-11-03' } });
  expect(screen.getByText('Período consultado: 2026-11-01 – 2026-11-07 UTC')).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () => json({ ...example, period: { ...example.period, from: '2026-11-03' } }));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Consultar' }));
  expect(await screen.findByText('Período consultado: 2026-11-03 – 2026-11-07 UTC')).toBeVisible();
});
it.each([[403,'No tienes acceso a un socio habilitado.'],[503,'No se pudo consultar la integración.'],[400,'Revisa el período: máximo 31 días.']])('shows %s without fabricated metrics', async (status, message) => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'synthetic', traceId: example.traceId }, Number(status)))); show();
  expect(await screen.findByRole('alert')).toHaveTextContent(String(message));
  expect(screen.queryByRole('heading', { name: 'Actividad del período' })).not.toBeInTheDocument();
});
it('reports a genuine empty period while keeping valid credential metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ ...example, items: [], totals: { completed: 0, accepted: 0, preliminary: 0, declined: 0 } }))); show();
  expect(await screen.findByText('Sin transacciones en el período.')).toBeVisible();
  expect(screen.getByText(example.credentials[0].id)).toBeVisible();
});
it('discards a superseded request and clears protected data on revoked access after focus', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })).mockImplementation(async () => json({ error: 'forbidden', traceId: example.traceId }, 403));
  vi.stubGlobal('fetch', fetch); show();
  fireEvent.focus(window);
  expect(await screen.findByRole('alert')).toHaveTextContent('No tienes acceso');
  resolve(json(example));
  await waitFor(() => expect(screen.queryByText('synthetic-partner')).not.toBeInTheDocument());
});
it('rejects malformed success, clears the page on session loss and supports English', async () => {
  const fetch = vi.fn(async () => json({ ...example, credentials: [{ ...example.credentials[0], status: ['active'] }] })); vi.stubGlobal('fetch', fetch); show(true);
  expect(await screen.findByRole('alert')).toHaveTextContent('The integration could not be loaded.');
  fetch.mockImplementation(async () => json({ error: 'unauthorized', traceId: example.traceId }, 401));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(lost).toHaveBeenCalled());
});

it('never restores protected data from a pending response after the tab is hidden', async () => {
  let resolve!: (response: Response) => void;
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })).mockImplementation(async () => json({ error: 'forbidden', traceId: example.traceId }, 403));
  vi.stubGlobal('fetch', fetch); show();
  hidden.mockReturnValue(true); fireEvent(document, new Event('visibilitychange'));
  await act(async () => { resolve(json(example)); await Promise.resolve(); });
  expect(screen.queryByText('synthetic-partner')).not.toBeInTheDocument();
  hidden.mockReturnValue(false); fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByRole('alert')).toHaveTextContent('No tienes acceso');
  expect(screen.queryByText('synthetic-partner')).not.toBeInTheDocument();
});
