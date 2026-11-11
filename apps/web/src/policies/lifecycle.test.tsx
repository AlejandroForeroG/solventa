import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { I18n } from '../i18n/I18n';
import { LifecycleActions } from './LifecycleActions';
import { readPolicyDetail, type PolicyDetail } from './api';
const policyId = '10000000-0000-4000-8000-000000000001', traceId = '50000000-0000-4000-8000-000000000001';
const policy: PolicyDetail = { policyId, product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveUntil: '2099-10-15T00:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' },
  exclusions: [], conditionsVersion: 'academic-conditions-1', documents: [], payments: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('retains a command identity after an uncertain cancellation and reports success only from the confirmed response', async () => {
  const changed = vi.fn(), lost = vi.fn(); let attempts = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/issued')) return json({ policies: [], hasMore: false, traceId });
    if (!url.endsWith('/lifecycle')) return json({ documentHash: 'a'.repeat(64), traceId });
    expect(init?.method).toBe('POST'); attempts++;
    return attempts === 1 ? json({ error: 'financial_unavailable', traceId }, 503)
      : json({ policyId, lifecycle: { action: 'cancelled', at: '2026-11-11T12:00:00.000Z', reason: 'customer_request', replacementPolicyId: null }, traceId });
  }); vi.stubGlobal('fetch', fetch);
  render(<I18n initial="es-CO"><LifecycleActions policy={policy} onChanged={changed} onSessionLost={lost} /></I18n>);
  const user = userEvent.setup();
  expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'Confirmo esta operación' }));
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se confirmó el cambio'); expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Cancelar' })); expect(changed).toHaveBeenCalledOnce();
  const commands = fetch.mock.calls.filter(([url]) => url.endsWith('/lifecycle'));
  expect(commands[0][1]?.body).toBe(commands[1][1]?.body); expect(commands[0][1]?.headers).toEqual(commands[1][1]?.headers);
});

it('explains renewal eligibility before offering a replacement purchase, in the selected language', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ policies: [], hasMore: false, traceId })));
  render(<I18n initial="en-US"><LifecycleActions policy={policy} onChanged={vi.fn()} onSessionLost={vi.fn()} /></I18n>);
  await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'renewed');
  expect(screen.getByText(/You can renew after the previous policy expires/)).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Quote replacement' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Renew' })).toBeDisabled();
});

it.each([{ action: 'broken', at: '2026-11-11T12:00:00Z', reason: 'customer_request', replacementPolicyId: null },
  { action: ['cancelled'], at: '2026-11-11T12:00:00Z', reason: 'customer_request', replacementPolicyId: null },
  { action: 'cancelled', at: 'yesterday', reason: 'customer_request', replacementPolicyId: null },
  { action: 'modified', at: '2026-11-11T12:00:00Z', reason: 'coverage_change', replacementPolicyId: null }])('rejects an invalid lifecycle in the detail response: %s', async lifecycle => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ ...policy, lifecycle, traceId })));
  expect((await readPolicyDetail(policyId, new AbortController().signal)).kind).toBe('unavailable');
});

it('rejects a non-string contract state in the issued list', async () => {
  const { listPolicies } = await import('./api');
  vi.stubGlobal('fetch', vi.fn(async () => json({ policies: [{ ...policy, contractStatus: ['cancelled'] }], hasMore: false, traceId })));
  expect((await listPolicies(new AbortController().signal)).kind).toBe('unavailable');
});
