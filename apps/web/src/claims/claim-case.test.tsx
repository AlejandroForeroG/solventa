import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { I18n } from '../i18n/I18n';
import { ClaimCase } from './ClaimCase';
import examples from '../../../../packages/contracts/examples/claims.json';

const claimId = examples.ownedCases.items[0].claimId;
const traceId = examples.caseFile.traceId;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const showCase = (audience: 'case' | 'customer') => render(<I18n initial="es-CO">
  <ClaimCase claimId={claimId} audience={audience} onSessionLost={vi.fn()} />
</I18n>);

afterEach(() => vi.unstubAllGlobals());

it('retains the analyst’s reason and command key when an approval succeeds after a retry', async () => {
  const user = userEvent.setup();
  const bodies: unknown[] = [];
  const keys: string[] = [];
  let approved = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/decisions')) {
      bodies.push(JSON.parse(String(init?.body)));
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (bodies.length === 1) return json({ error: 'service_unavailable', traceId }, 503);
      approved = true;
      return json(examples.decisionResult);
    }
    return json({ ...examples.caseFile, state: approved ? 'approved' : 'in_review' });
  }));
  showCase('case');
  await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
  await user.type(screen.getByRole('textbox', { name: 'Motivo' }), 'Evidence evaluated by the assigned analyst.');
  await user.click(screen.getByRole('checkbox', { name: 'Documento 1' }));
  await user.click(screen.getByRole('button', { name: 'Confirmar acción' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar el resultado');
  expect(screen.getByRole('textbox', { name: 'Motivo' })).toHaveValue('Evidence evaluated by the assigned analyst.');
  await user.click(screen.getByRole('button', { name: 'Confirmar acción' }));
  expect(await screen.findByText('Siniestro aprobado.')).toBeVisible();
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
});

it('shows the owner the requested information and confirms their response', async () => {
  const user = userEvent.setup();
  let received = false;
  const requirement = {
    id: '11111111-1111-4111-8111-111111111114', details: 'Indica la dirección del incidente.',
    deadline: new Date(Date.now() + 3600000).toISOString(), status: 'pending',
    responseText: null, receivedAt: null, evidenceIds: []
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/response')) {
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'Calle de prueba 20.', evidenceIds: [] });
      received = true;
      return json({ ...examples.actionReceipt, state: 'in_review' });
    }
    const result = received ? { ...requirement, status: 'received', responseText: 'Calle de prueba 20.', receivedAt: new Date().toISOString() } : requirement;
    return json({ ...examples.caseFile, access: 'customer', state: received ? 'in_review' : 'pending_information', requirements: [result] });
  }));
  showCase('customer');
  await user.click(await screen.findByRole('button', { name: 'Tareas' }));
  expect(screen.getByText(requirement.details)).toBeVisible();
  expect(screen.getByText('Titular de la póliza')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
  await user.type(screen.getByRole('textbox', { name: 'Tu respuesta' }), 'Calle de prueba 20.');
  await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }));
  expect(await screen.findByText('Calle de prueba 20.')).toBeVisible();
  expect(within(screen.getByRole('main')).getByText('Solicitud de información · Recibida')).toBeVisible();
});
