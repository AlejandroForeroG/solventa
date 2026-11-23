import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18n } from '../i18n/I18n';
import { ChannelShell } from './ChannelShell';
import type { OperationalWorkspace } from '@solventa/contracts';

const renderShell = (workspaces: readonly OperationalWorkspace[] = []) => render(<I18n initial="es-CO"><ChannelShell authenticated workspaces={workspaces} canLogin={false} busy={false} onLogin={vi.fn()} onLogout={vi.fn()}><main>Content</main></ChannelShell></I18n>);
afterEach(() => { window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); });
describe('channel navigation', () => {
  it.each(['/polizas', '/siniestros'])('keeps customer navigation without operational access at %s', path => {
    window.history.replaceState({}, '', path); renderShell();
    expect(screen.queryByRole('complementary', { name: 'Consola operativa' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menú de mi cuenta' }));
    expect(screen.queryByRole('menuitem', { name: 'Consola de operaciones' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cerrar sesión' })).toBeVisible();
  });

  it('marks the customer location and opens the first authorized operational workspace', () => {
    window.history.replaceState({}, '', '/polizas'); renderShell(['reports', 'audit']);
    const nav = within(screen.getByRole('complementary', { name: 'Mi cuenta' }));
    expect(nav.getByRole('link', { name: 'Mis pólizas' })).toHaveAttribute('aria-current', 'page');
    expect(nav.queryByRole('link', { name: 'Auditoría' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menú de mi cuenta' }));
    expect(screen.getByRole('menuitem', { name: 'Consola de operaciones' })).toHaveAttribute('href', '/reportes');
    expect(screen.getByRole('menuitem', { name: 'Cerrar sesión' })).toBeVisible();
  });
  it('keeps a single operational navigation with a return to the customer policies', () => {
    window.history.replaceState({}, '', '/auditoria'); renderShell(['audit', 'partner']);
    const nav = within(screen.getByRole('complementary', { name: 'Consola operativa' }));
    expect(nav.getByRole('link', { name: 'Auditoría' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Portal de socios' })).toHaveAttribute('href', '/socios');
    expect(nav.queryByRole('link', { name: 'Siniestros' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: 'Reportes' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menú de mi cuenta' }));
    expect(screen.getByRole('menuitem', { name: 'Volver a mi cuenta' })).toHaveAttribute('href', '/polizas');
  });
  it('opens the native modal and clears expanded state when it is dismissed', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    renderShell();
    const trigger = screen.getByRole('button', { name: 'Abrir menú' }); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Menú de navegación' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const close = within(dialog).getByRole('button', { name: 'Cerrar menú' });
    const links = within(dialog).getAllByRole('link');
    const last = links[links.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.click(close);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });
});
