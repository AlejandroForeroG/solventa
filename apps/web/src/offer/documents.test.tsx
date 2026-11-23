import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import type { Policy } from './api';
import { PolicyDocument, PolicyIssued } from './OfferViews';

const policyId = '10000000-0000-4000-8000-000000000001';
const traceId = '50000000-0000-4000-8000-000000000009';
const document = JSON.stringify({ coverage: { kind: 'mortgage_life', sumInsured: '250000000.0000', currency: 'COP' }, offerVersion: 1, policyId, premium: '86400.0000', providerMode: 'mock' });
const policy: Policy = { policyId, offerId: '20000000-0000-4000-8000-000000000002', status: 'issued', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-11-22T05:00:00.000Z', effectiveUntil: '2027-11-22T05:00:00.000Z', document, documentHash: 'c'.repeat(64),
  payment: { status: 'confirmed', reference: 'MOCK-30000000-0000-4000-8000-000000000003' }, replayed: false, traceId };
const detail = { policyId, product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP', effectiveFrom: policy.effectiveFrom, effectiveUntil: policy.effectiveUntil,
  coverage: { kind: 'mortgage_life', sumInsured: '250000000.0000' }, exclusions: [], conditionsVersion: 'academic-conditions-1',
  documents: [{ documentId: 'signed_policy', issuedAt: '2026-11-22T20:15:00.000Z' }], payments: [], traceId };
const noop = () => {};

function serve(pdf: () => Response) {
  const fetch = vi.fn(async (url: string) => {
    if (url === `/api/v1/policies/${policyId}/detail`) return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === `/api/v1/policies/${policyId}/documents/signed_policy`) return pdf();
    throw new Error('unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('policy documents', () => {
  it('downloads the issued policy PDF from the server with the policy number as file name and shows the applied signature', async () => {
    const fetch = serve(() => new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="signed-policy-10000000.pdf"' } }));
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() });
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const { container } = render(<I18n initial="es-CO"><PolicyIssued heading={createRef()} policy={policy} holderName="María Fernanda Rodríguez" /></I18n>);
    const sheet = screen.getByRole('article', { name: 'Póliza de seguro de vida grupo deudores' });
    expect(within(sheet).getByText('Firmado electrónicamente (simulado)')).toBeVisible();
    expect(within(sheet).getAllByText('María Fernanda Rodríguez')).toHaveLength(2);
    expect(within(sheet).getByRole('img', { name: /Trazo ilustrativo/ })).toBeInTheDocument();
    expect(await within(sheet).findByText(/22 de noviembre de 2026.*\(hora de Bogotá\)/, { selector: 'dd' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Descargar PDF' }));
    await waitFor(() => expect(saved).toEqual(['poliza-POL-10000000.pdf']));
    expect(fetch).toHaveBeenCalledWith(`/api/v1/policies/${policyId}/documents/signed_policy`, expect.objectContaining({ method: 'GET', headers: { accept: 'application/pdf' } }));
    expect(screen.getByRole('status')).toHaveTextContent('PDF descargado: poliza-POL-10000000.pdf');
    expect(print).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reports a failed download instead of printing the page', async () => {
    serve(() => new Response(JSON.stringify({ error: 'financial_unavailable', traceId }), { status: 503, headers: { 'content-type': 'application/json' } }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const print = vi.fn();
    vi.stubGlobal('print', print);
    render(<I18n initial="es-CO"><PolicyIssued heading={createRef()} policy={policy} /></I18n>);
    await userEvent.click(screen.getByRole('button', { name: 'Descargar PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos descargar el PDF');
    expect(screen.getByRole('button', { name: 'Reintentar descarga' })).toBeVisible();
    expect(click).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
  });

  it('prints only the two preview pages before issuance and suggests the preview file name', async () => {
    const titles: string[] = [];
    vi.stubGlobal('print', vi.fn(() => {
      titles.push(window.document.title);
      expect(window.document.querySelectorAll('.doc-print-root article')).toHaveLength(2);
    }));
    window.document.title = 'Solventa';
    render(<I18n initial="es-CO"><PolicyDocument heading={createRef()} policy={{ ...policy, status: 'pending', payment: null }} stage="review" checked={false} documentChanged={false}
      challenge={null} code="" busy={false} error={null} onCode={noop} onCheck={noop} onBegin={noop} onCancel={noop} onConfirm={noop} onContinue={noop} /></I18n>);
    expect(screen.getByText('Vista previa sin validez. El PDF de la póliza se descarga después de firmarla.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Imprimir vista previa' }));
    await waitFor(() => expect(titles).toEqual(['poliza-POL-10000000-vista-previa']));
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(window.document.title).toBe('Solventa'));
    expect(window.document.querySelector('.doc-print-root')).toBeNull();
  });
});
