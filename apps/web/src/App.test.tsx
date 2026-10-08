import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from './App';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function serve(session: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = String(input);
    if (path === '/auth/session') return json({ authenticated: session === 200 }, session);
    if (path === '/api/v1/consents') return json({ items: [] });
    return json({ error: 'not_found' }, 404);
  });
}

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe('privacy dashboard in the application', () => {
  it('is reachable from the header only with a session, and going back keeps what was typed', async () => {
    serve(200);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const open = await screen.findByRole('button', { name: 'Panel de privacidad' });
    await user.type(screen.getByLabelText(/Nombre completo/), 'Cliente Sintetico Uno');

    await user.click(open);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tus datos y quién los usa' })).toHaveFocus();
    expect(await screen.findByText('Aún no has dado ninguna autorización.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Volver' }));
    await waitFor(() => expect(screen.getByLabelText(/Nombre completo/)).toBeVisible());
    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue('Cliente Sintetico Uno');
  });

  it('is not offered without a session', async () => {
    serve(401);
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Continuar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Panel de privacidad' })).toBeNull();
  });

  it('follows the language of the interface', async () => {
    serve(200);
    window.localStorage.setItem('solventa.locale', 'en-US');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Privacy dashboard' })).toBeInTheDocument();
  });
});
