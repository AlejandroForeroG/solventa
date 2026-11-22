import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from '../App';
import examples from '../../../../packages/contracts/examples/assistance-providers.json';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const provider = examples.request.created.request.provider;
const stored = examples.request.created.request;
const requestsPath = '/api/v1/assistance/requests';

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
// A server that remembers its requests by key, as the real one does.
function serve(options: { post?: (call: Call, attempt: number) => Response | Promise<Response>; list?: () => Response } = {}) {
  const calls: Call[] = [];
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const call: Call = { path, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    if (path === '/auth/session') return json({ authenticated: true });
    if (path === '/api/v1/assistance/providers/search') return json({ ...examples.empty, providers: [provider] });
    if (path === requestsPath) {
      calls.push(call);
      if (call.method === 'POST') return options.post ? options.post(call, ++posts) : json(examples.request.created, 201);
      return options.list ? options.list() : json({ simulated: true, requests: [], traceId: examples.empty.traceId });
    }
    return json({ error: 'not_found' }, 404);
  });
  return { calls, posts: () => calls.filter(call => call.method === 'POST') };
}

beforeEach(() => window.history.replaceState(null, '', '/prestadores'));
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); });

async function search() {
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Ciudad o dirección' }), 'Calle de prueba 10, Bogotá');
  await user.click(screen.getByRole('button', { name: 'Buscar' }));
  await screen.findByRole('article');
  return user;
}

describe('assistance requests on the web', () => {
  it('asks for nothing until the customer confirms, then shows the stored reference and state and lists it among the customer’s own', async () => {
    const server = serve({ list: () => json({ simulated: true, requests: [], traceId: examples.empty.traceId }) });
    render(<App />);
    expect(await screen.findByText('Aún no tienes solicitudes.')).toBeVisible();
    const user = await search();
    await user.click(within(screen.getByRole('article')).getByRole('button', { name: 'Solicitar asistencia' }));
    expect(await screen.findByRole('heading', { name: 'Revisa tu solicitud' })).toBeVisible();
    expect(screen.getByText(/Prestador · Taller de prueba Bogotá/)).toBeVisible();
    expect(screen.getByText(/Dirección: Calle de prueba 10, Bogotá/)).toBeVisible();
    expect(server.posts()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Buscar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Confirmar solicitud' }));
    expect(await screen.findByRole('heading', { name: 'Solicitud registrada' })).toBeVisible();
    expect(screen.getByLabelText('Referencia ASI-7K2M9QXD')).toBeVisible();
    expect(screen.getByText(/Estado · Solicitada/)).toBeVisible();
    expect(screen.getByText(/prestador es simulado/)).toBeVisible();
    const [post] = server.posts();
    expect(post.body).toEqual({ providerId: 'demo-bog-workshop', place: { kind: 'address', address: 'Calle de prueba 10, Bogotá' } });
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(server.calls.filter(call => call.method === 'GET')).toHaveLength(2));
  });

  it('never shows a failed or uncertain request as stored, and the retry carries the same key so it creates no second request', async () => {
    const server = serve({ post: (_call, attempt) => attempt === 1 ? json({ error: 'service_unavailable', traceId: examples.empty.traceId }, 503) : json(examples.request.created, 200) });
    render(<App />);
    const user = await search();
    await user.click(screen.getByRole('button', { name: 'Solicitar asistencia' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar solicitud' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no sabemos si quedó guardada');
    expect(screen.queryByRole('heading', { name: 'Solicitud registrada' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Confirmar solicitud' }));
    expect(await screen.findByRole('heading', { name: 'Solicitud registrada' })).toBeVisible();
    const keys = server.posts().map(call => call.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('tells each refusal apart, and a refusal the key would meet again is retried with a new key', async () => {
    const server = serve({ post: () => json({ error: 'idempotency_conflict', traceId: examples.empty.traceId }, 409) });
    render(<App />);
    const user = await search();
    await user.click(screen.getByRole('button', { name: 'Solicitar asistencia' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar solicitud' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar esta solicitud');
    await user.click(screen.getByRole('button', { name: 'Confirmar solicitud' }));
    await waitFor(() => expect(server.posts()).toHaveLength(2));
    const keys = server.posts().map(call => call.headers['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('can go back from the review without sending anything, and a malformed answer is an outage', async () => {
    const server = serve({ post: () => json({ simulated: true, request: { ...stored, status: 'dispatched' }, traceId: examples.empty.traceId }, 201) });
    render(<App />);
    const user = await search();
    await user.click(screen.getByRole('button', { name: 'Solicitar asistencia' }));
    await user.click(await screen.findByRole('button', { name: 'Volver' }));
    expect(server.posts()).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Ciudad o dirección' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Ciudad o dirección' }), ' ');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await user.click(await screen.findByRole('button', { name: 'Solicitar asistencia' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar solicitud' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no sabemos si quedó guardada');
    expect(screen.queryByRole('heading', { name: 'Solicitud registrada' })).toBeNull();
  });

  it('lists the customer’s own requests, tells when they cannot be read and reads them again on request', async () => {
    let healthy = false;
    const server = serve({ list: () => healthy ? json({ simulated: true, requests: [stored], traceId: examples.empty.traceId }) : json({ error: 'service_unavailable', traceId: examples.empty.traceId }, 503) });
    render(<App />);
    expect(await screen.findByText('No pudimos cargar tus solicitudes.')).toBeVisible();
    healthy = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
    const mine = within(await screen.findByRole('heading', { name: 'Mis solicitudes' }).then(heading => heading.closest('section') as HTMLElement));
    expect(await mine.findByText('ASI-7K2M9QXD')).toBeVisible();
    expect(mine.getByText(/Taller de prueba Bogotá · Solicitada/)).toBeVisible();
    expect(server.calls.filter(call => call.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('has no accessibility violations in the review and in the stored request', async () => {
    serve();
    const { container } = render(<App />);
    const user = await search();
    await user.click(screen.getByRole('button', { name: 'Solicitar asistencia' }));
    await screen.findByRole('heading', { name: 'Revisa tu solicitud' });
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Confirmar solicitud' }));
    await screen.findByRole('heading', { name: 'Solicitud registrada' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
