import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18n } from '../i18n/I18n';
import { ProviderSearch } from './ProviderSearch';
import { assistanceRequestsPath, assistanceSearchPath } from '@solventa/contracts';

afterEach(() => vi.unstubAllGlobals());
it('renews an expired session once and repeats the same directory search', async () => {
  let searches = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url === assistanceRequestsPath) return Response.json({ simulated: true, requests: [], traceId: '50000000-0000-4000-8000-000000000001' });
    if (url === '/auth/session') return Response.json({});
    expect(url).toBe(assistanceSearchPath);
    return ++searches === 1 ? new Response(null, { status: 401 })
      : Response.json({ simulated: true, traceId: '50000000-0000-4000-8000-000000000001', providers: [] });
  });
  vi.stubGlobal('fetch', fetcher); const lost = vi.fn();
  render(<I18n initial="es-CO"><ProviderSearch onSessionLost={lost} /></I18n>);
  const user = userEvent.setup(); await user.type(screen.getByRole('textbox'), 'Bogotá');
  await user.click(screen.getByRole('button', { name: 'Buscar' }));
  await screen.findByText('No encontramos prestadores en esa zona.');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls.filter(([url]) => url === '/auth/session')).toHaveLength(1);
  const searchCalls = fetcher.mock.calls.filter(([url]) => url === assistanceSearchPath);
  expect(searchCalls).toHaveLength(2);
  expect(searchCalls[0]).toEqual(searchCalls[1]);
  expect(lost).not.toHaveBeenCalled();
});
