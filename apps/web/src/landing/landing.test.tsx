import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import App from '../App';

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); });

const sessionResponse = (status: number) => new Response(JSON.stringify({ authenticated: status === 200 }), { status, headers: { 'content-type': 'application/json' } });

describe('product landing and quote entry', () => {
  it.each([200, 401, 503])('introduces the product with a usable quote entry when the session returns %s', async status => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(status));
    const { container } = render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Conoce el seguro de vida de tu crédito.' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Comenzar cotización' })).toHaveAttribute('href', '/cotizar');
    expect(screen.getByRole('link', { name: 'Cómo funciona' })).toHaveAttribute('href', '#how-it-works');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/Iniciar sesión no concede esa autorización/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
    expect(fetchMock.mock.calls.every(([path]) => path === '/auth/session')).toBe(true);
  });

  it('exposes session failures and retries without treating an unknown session as anonymous', async () => {
    let resolveSession!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sessionResponse(503))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSession = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    const retry = await screen.findByRole('button', { name: 'Reintentar' });
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos comprobar tu sesión.');
    expect(screen.queryByRole('link', { name: 'Iniciar sesión' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Comenzar cotización' })).toBeVisible();
    await user.click(retry);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Iniciar sesión' })).toBeNull();
    resolveSession(sessionResponse(200));
    expect(await screen.findByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Conoce el seguro de vida de tu crédito.' })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([path]) => path === '/auth/session')).toBe(true);
  });

  it('keeps the language switch and native navigation usable from the keyboard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(401));
    const user = userEvent.setup();
    render(<App />);
    await user.tab();
    expect(screen.getByRole('link', { name: 'Inicio de Solventa' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /Cambiar la interfaz a inglés/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Understand the life insurance for your loan.' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Start a quote' })).toHaveAttribute('href', '/cotizar');
    expect(screen.getByRole('link', { name: 'Solventa home' })).toHaveAttribute('href', '/');
    expect(screen.getByText(/Signing in does not grant that authorization/)).toBeVisible();
  });

  it('keeps the authenticated quote at its direct URL', async () => {
    window.history.replaceState(null, '', '/cotizar');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(200));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Cotiza el seguro de vida de tu crédito' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Pasos de la contratación' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Comenzar cotización' })).toBeNull();
  });

  it('shows a failed login return instead of hiding its recovery in the landing', async () => {
    window.history.replaceState(null, '', '/?auth=failed');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse(401));
    render(<App />);
    expect(await screen.findByText('No se completó el acceso. Intenta de nuevo.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Comenzar cotización' })).toBeNull();
  });
});
