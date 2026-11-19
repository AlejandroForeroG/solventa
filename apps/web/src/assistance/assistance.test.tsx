import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18n } from '../i18n/I18n';
import { ProviderSearch } from './ProviderSearch';

afterEach(() => vi.unstubAllGlobals());
it('renews an expired session once and repeats the same directory search', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(Response.json({ simulated: true, traceId: '50000000-0000-4000-8000-000000000001', providers: [] }));
  vi.stubGlobal('fetch', fetcher); const lost = vi.fn();
  render(<I18n initial="es-CO"><ProviderSearch onSessionLost={lost} /></I18n>);
  const user = userEvent.setup(); await user.type(screen.getByRole('textbox'), 'Bogotá');
  await user.click(screen.getByRole('button', { name: 'Buscar' }));
  await screen.findByText('No encontramos prestadores en esa zona.');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[1][0]).toBe('/auth/session');
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[2]);
  expect(lost).not.toHaveBeenCalled();
});
