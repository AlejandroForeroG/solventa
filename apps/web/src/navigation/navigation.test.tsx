import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18n } from '../i18n/I18n';
import { ChannelShell } from './ChannelShell';

const renderShell = () => render(<I18n initial="es-CO"><ChannelShell authenticated canLogin={false} busy={false} onLogin={vi.fn()} onLogout={vi.fn()}><main>Content</main></ChannelShell></I18n>);
afterEach(() => { window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); });
describe('channel navigation', () => {
  it('marks the customer location and groups operational routes behind their workspace entry', () => {
    window.history.replaceState({}, '', '/polizas'); renderShell();
    const nav = within(screen.getByRole('complementary', { name: 'Mi cuenta' }));
    expect(nav.getByRole('link', { name: 'Mis pólizas' })).toHaveAttribute('aria-current', 'page');
    expect(nav.queryByRole('link', { name: 'Auditoría' })).toBeNull();
    expect(nav.getByRole('link', { name: 'Área de trabajo' })).toHaveAttribute('href', '/siniestros');
  });
  it('keeps a single operational navigation with a return to the customer policies', () => {
    window.history.replaceState({}, '', '/auditoria'); renderShell();
    const nav = within(screen.getByRole('complementary', { name: 'Consola operativa' }));
    expect(nav.getByRole('link', { name: 'Auditoría' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Volver a mi cuenta' })).toHaveAttribute('href', '/polizas');
  });
  it('opens the native modal and clears expanded state when it is dismissed', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    renderShell();
    const trigger = screen.getByRole('button', { name: 'Abrir menú' }); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Menú de navegación' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const close = within(dialog).getByRole('button', { name: 'Cerrar menú' });
    const logout = within(dialog).getByRole('button', { name: 'Cerrar sesión' });
    logout.focus();
    fireEvent.keyDown(logout, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(logout).toHaveFocus();
    fireEvent.click(close);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });
});
