import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { I18n } from '../i18n/I18n';
import { AdvisorActions } from './AdvisorActions';
import { validApproval } from './api';
import type { PolicyDetail } from '../policies/api';

const policyId='11111111-1111-4111-8111-111111111111',reference='22222222-2222-4222-8222-222222222222',traceId='33333333-3333-4333-8333-333333333333';
const approval={authorizationId:'44444444-4444-4444-8444-444444444444',advisorReference:reference,policyId,action:'cancelled',replacementPolicyId:null,documentHash:'a'.repeat(64),
  grantedAt:'2026-11-11T00:00:00.000Z',expiresAt:'2026-11-12T00:00:00.000Z',status:'active',changeId:null,revokedAt:null};
const json=(value:unknown,status=200)=>new Response(JSON.stringify({...value as object,traceId}),{status,headers:{'content-type':'application/json'}});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('requires explicit customer approval and retries an uncertain grant with the same command identity',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const posts:RequestInit[]=[];const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
    if(init?.method==='POST'){posts.push(init);return json({error:'financial_unavailable'},503);}
    if(url.endsWith('/advisor-authorizations'))return json({status:'ok',authorizations:[],hasMore:false});
    return json({documentHash:'a'.repeat(64)});
  });vi.stubGlobal('fetch',fetch);
  // Only the policy selector and lifecycle state are consumed by this owner approval panel.
  render(<I18n><AdvisorActions policy={{policyId} as PolicyDetail} onSessionLost={()=>{}}/></I18n>);
  await screen.findByText('Sin autorizaciones.');
  await userEvent.setup().click(screen.getByText('Nueva autorización', { selector: 'summary' }));
  const button=screen.getByRole('button',{name:'Autorizar'});expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Referencia del asesor'),{target:{value:reference}});
  expect(screen.getByLabelText('Actuación')).toHaveValue('');
  await userEvent.setup().selectOptions(screen.getByLabelText('Actuación'),'cancelled');
  await userEvent.setup().click(screen.getByLabelText('Autorizo a mi asesor a cancelar esta póliza'));
  await userEvent.setup().click(button);expect(await screen.findByRole('alert')).toHaveTextContent('No se confirmó');
  vi.setSystemTime(new Date('2026-11-11T00:03:00Z'));
  await userEvent.setup().click(button);await waitFor(()=>expect(posts).toHaveLength(2));
  expect(posts[0].headers).toEqual(posts[1].headers);expect(posts[0].body).toEqual(posts[1].body);
  expect(String(posts[0].body)).not.toContain('clientId');
});
it('filters the owner table across pages and distinguishes approval from execution', async () => {
  const executed = { ...approval, authorizationId: '55555555-5555-4555-8555-555555555555', status: 'executed', changeId: traceId };
  const cursor = `${approval.grantedAt}|${approval.authorizationId}`;
  const fetch = vi.fn(async (url: string) => url.includes('after=')
    ? json({ authorizations: [executed], hasMore: false, nextCursor: null })
    : json({ authorizations: [approval], hasMore: true, nextCursor: cursor }));
  vi.stubGlobal('fetch', fetch);
  const { container } = render(<I18n><AdvisorActions policy={{ policyId } as PolicyDetail} onSessionLost={() => {}} /></I18n>);
  const table = await screen.findByRole('table', { name: 'Autorizaciones de asesor' });
  expect(within(table).getByText('Aprobada', { exact: true })).toBeVisible();
  expect(await axe(container)).toHaveNoViolations();
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por estado' }), 'executed');
  const filtered = await screen.findByRole('table', { name: 'Autorizaciones de asesor' });
  expect(within(filtered).getByText('Ejecutada', { exact: true })).toBeVisible();
  expect(within(filtered).queryByText('Aprobada', { exact: true })).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => url.includes('after='))).toBe(true);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por estado' }), 'revoked');
  expect(await screen.findByText('No hay autorizaciones con este estado.')).toBeVisible();
});
it('shows only addressed approvals, confirms the exact action and clears protected content on access revocation',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const lost=vi.fn(),fetch=vi.fn(async()=>json({status:'ok',advisorReference:reference,authorizations:[approval],hasMore:false}));vi.stubGlobal('fetch',fetch);
  const {container}=render(<I18n><AdvisorActions onSessionLost={lost}/></I18n>);
  expect(await screen.findByText(policyId)).toBeVisible();expect(screen.getByRole('button',{name:'Ejecutar actuación autorizada'})).toBeDisabled();
  expect(await axe(container)).toHaveNoViolations();
  fetch.mockImplementation(async()=>json({error:'forbidden'},403));fireEvent.focus(window);
  expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso');expect(screen.queryByText(policyId)).not.toBeInTheDocument();
});
it('rejects inconsistent authorization projections before enabling an action',()=>{
  expect(validApproval(approval)).toBe(true);
  for(const change of [{status:'executed'},{action:'modified'},{expiresAt:approval.grantedAt},{changeId:traceId}])expect(validApproval({...approval,...change})).toBe(false);
});
it('lets the owner revoke an executed approval while preserving the execution history',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  let revoked=false;
  const executed={...approval,status:'executed',changeId:traceId};
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
    if(init?.method==='POST'){expect(url).toContain('/revoke');revoked=true;return json({status:'ok',authorization:{...executed,revokedAt:'2026-11-11T00:00:00.000Z'},replayed:false});}
    return json({status:'ok',authorizations:[{...executed,revokedAt:revoked?'2026-11-11T00:00:00.000Z':null}],hasMore:false,nextCursor:null});
  });vi.stubGlobal('fetch',fetch);
  render(<I18n><AdvisorActions policy={{policyId,lifecycle:{action:'cancelled'}} as PolicyDetail} onSessionLost={()=>{}}/></I18n>);
  await userEvent.setup().click(await screen.findByRole('button',{name:'Revocar'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Revocar'})).not.toBeInTheDocument());
  const table = within(screen.getByRole('table', { name: 'Autorizaciones de asesor' }));
  expect(table.getByText('Ejecutada', { exact: true })).toBeVisible();
  expect(table.getByText(/^Revocada:/)).toBeVisible();
});
