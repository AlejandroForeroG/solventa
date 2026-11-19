import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { I18n } from '../i18n/I18n';
import { ClaimDisbursement } from './ClaimDisbursement';
import { approvedAmount } from './disbursement-api';
import { OwnClaimPayments } from './OwnClaimPayments';

const claimId = '11111111-1111-4111-8111-111111111111';
const paymentId = '11111111-1111-4111-8111-111111111112';
const traceId = '11111111-1111-4111-8111-111111111113';
const receipt = { paymentId, amount: '1000.0000', currency: 'COP', status: 'pending', reference: null, simulated: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const display = (props: Partial<Parameters<typeof ClaimDisbursement>[0]> = {}) => render(<I18n initial="es-CO">
  <ClaimDisbursement claimId={claimId} paid={false} onSessionLost={vi.fn()} onConfirmed={vi.fn()} {...props} />
</I18n>);
afterEach(() => vi.unstubAllGlobals());

it('requires amount review and retries the exact amount after an uncertain response', async () => {
  const user = userEvent.setup();
  const bodies: unknown[] = [];
  let current: typeof receipt | null = null;
  const confirmed = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)));
      current = receipt;
      return bodies.length === 1 ? json({ error: 'service_unavailable', traceId }, 503)
        : json({ payment: current, replayed: true, traceId }, 202);
    }
    return current ? json({ payment: current, traceId }) : json({ error: 'not_found', traceId }, 404);
  }));
  display({ onConfirmed: confirmed });
  await user.type(await screen.findByRole('textbox', { name: 'Monto aprobado (COP)' }), '1000,00');
  await user.click(screen.getByRole('button', { name: 'Revisar monto' }));
  expect(bodies).toHaveLength(0);
  expect(screen.getByText('1.000,0000 COP')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Autorizar desembolso' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar');
  expect(screen.queryByRole('textbox')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Reintentar el mismo monto' }));
  expect(await screen.findByText('Pendiente de confirmación')).toBeVisible();
  expect(confirmed).not.toHaveBeenCalled();
  expect(screen.queryByText('Referencia del pago')).toBeNull();
  expect(bodies).toEqual([{ amount: '1000.0000' }, { amount: '1000.0000' }]);
});

it('restores a confirmed receipt through a read without sending another payment', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json({ payment: { ...receipt, status: 'confirmed', reference: 'MOCK-' + paymentId }, traceId }));
  vi.stubGlobal('fetch', fetcher);
  display({ paid: true });
  expect(await screen.findByText('Confirmado')).toBeVisible();
  expect(screen.getByText('MOCK-' + paymentId)).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/disbursement'), expect.not.objectContaining({ method: 'POST' }));
});

it('keeps a declined payment terminal and never offers a new authorization', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ payment: { ...receipt, status: 'declined' }, traceId })));
  display();
  expect(await screen.findByText('Rechazado')).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Autorizar desembolso' })).toBeNull();
});

it('blocks authorization after an unavailable read or an invalid receipt', async () => {
  const user = userEvent.setup();
  let invalid = false;
  vi.stubGlobal('fetch', vi.fn(async () => invalid
    ? json({ payment: { ...receipt, status: 'confirmed', reference: null }, traceId })
    : json({ error: 'service_unavailable', traceId }, 503)));
  display();
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar');
  expect(screen.queryByRole('textbox')).toBeNull();
  invalid = true;
  await user.click(screen.getByRole('button', { name: 'Consultar estado' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar');
  expect(screen.queryByText('Confirmado')).toBeNull();
});

it('clears the receipt when a fresh authorization is denied', async () => {
  const user = userEvent.setup();
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => denied ? json({ error: 'forbidden', traceId }, 403)
    : json({ payment: { ...receipt, status: 'confirmed', reference: 'MOCK-' + paymentId }, traceId })));
  display({ paid: true });
  expect(await screen.findByText('MOCK-' + paymentId)).toBeVisible();
  denied = true;
  await user.click(screen.getByRole('button', { name: 'Consultar estado' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('ya no tiene permiso');
  expect(screen.queryByText('MOCK-' + paymentId)).toBeNull();
});

it('preserves canonical decimal precision without grouping or floating point', () => {
  expect(approvedAmount('999999999999999,9999')).toBe('999999999999999.9999');
  expect(approvedAmount('0.0001')).toBe('0.0001');
  for (const input of ['0', '-1', '1e3', '1.000,00', '1,000.00', '1000000000000000', '0.00001']) expect(approvedAmount(input)).toBeNull();
});

it.each([403, 503])('clears the customer receipt after a failed replacement read with status %s', async status => {
  const user = userEvent.setup(); let denied = false;
  vi.stubGlobal('fetch', vi.fn(async () => denied ? json({ error: status === 403 ? 'forbidden' : 'service_unavailable', traceId }, status) : json({
    traceId, next: null, items: [{ claimId, claimNumber: 'SIN-2026-00001', updatedAt: '2026-11-19T15:00:00Z',
      payment: { ...receipt, status: 'confirmed', reference: 'MOCK-' + paymentId } }] })));
  render(<I18n initial="es-CO"><OwnClaimPayments onSessionLost={vi.fn()} /></I18n>);
  expect(await screen.findByText(new RegExp('MOCK-' + paymentId))).toBeVisible();
  expect(screen.getByRole('link', { name: 'SIN-2026-00001' })).toHaveAttribute('href', '/mis-siniestros/' + claimId);
  expect(screen.queryByRole('textbox')).toBeNull(); denied = true;
  await user.click(screen.getByRole('button', { name: 'Consultar estado' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(status === 403 ? 'ya no tiene permiso' : 'No pudimos consultar tus indemnizaciones');
  expect(screen.queryByText(new RegExp('MOCK-' + paymentId))).toBeNull();
});
