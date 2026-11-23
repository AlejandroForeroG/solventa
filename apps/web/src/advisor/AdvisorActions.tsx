import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { executeApproval, grantApproval, readApprovals, revokeApproval, uuid, type Approval, type ApprovalList, type Outcome } from './api';
import type { PolicyDetail } from '../policies/api';
import { AdvisorSale } from '../sale/AdvisorSale';
import { IconButton } from '../navigation/IconAction';
import '../policies/policies.css';
import { Icon } from '../navigation/Icon';
import { approvalStatuses, OwnerApprovalTable, type ApprovalFilter } from './OwnerApprovalTable';

const pageSize = 20;

async function readMatchingApprovals(policyId: string, status: Approval['status'], signal: AbortSignal): Promise<Outcome<ApprovalList>> {
  const authorizations: Approval[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (!signal.aborted) {
    const result = await readApprovals(policyId, signal, cursor);
    if (result.kind !== 'ok') return result;
    const page = result.value;
    authorizations.push(...page.authorizations.filter(approval => approval.status === status));
    if (!page.hasMore) return { kind: 'ok', value: { authorizations, hasMore: false, nextCursor: null } };
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  return { kind: 'unavailable' };
}

export function AdvisorActions({policy,onSessionLost,onReference}:{policy?:PolicyDetail;onSessionLost():void;onReference?(reference:string):void}) {
  const intl=useIntl(),t=(key:string)=>intl.formatMessage({id:`advisor.${key}`});
  const [cursors,setCursors]=useState<(string|undefined)[]>([undefined]);
  const [filter, setFilter] = useState<ApprovalFilter>('all');
  const [filteredPage, setFilteredPage] = useState(0);
  const [result,setResult]=useState<Outcome<ApprovalList>|null>(null),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const advisorReference=result?.kind==='ok'?result.value.advisorReference:undefined;
  useEffect(()=>{if(advisorReference)onReference?.(advisorReference);},[advisorReference,onReference]);
  const [reference,setReference]=useState(''),[action,setAction]=useState<Approval['action']|''>(''),[replacement,setReplacement]=useState('');
  const validUntil=(count:number)=>new Date(Date.now()+count*86400000-300000).toISOString();
  const [days,setDays]=useState(1),[expiresAt,setExpiresAt]=useState(()=>validUntil(1)),[confirmed,setConfirmed]=useState(false);
  const [selected,setSelected]=useState<string|null>(null),[executeConfirmed,setExecuteConfirmed]=useState(false);
  const command=useRef<{body:string;key:string}|null>(null),executions=useRef(new Map<string,string>());
  const policyId = policy?.policyId ?? null;
  useEffect(()=>{
    if(document.hidden)return;
    const abort=new AbortController();
    const read = policyId && filter !== 'all'
      ? readMatchingApprovals(policyId, filter, abort.signal)
      : readApprovals(policyId, abort.signal, cursors.at(-1));
    void read.then(value=>{if(!abort.signal.aborted&&!document.hidden){if(value.kind==='unauthenticated')onSessionLost();setResult(value);}});
    return()=>abort.abort();
  },[policyId,filter,refresh,onSessionLost,cursors]);
  useEffect(()=>{
    const update=()=>{setResult(null);setSelected(null);setExecuteConfirmed(false);setRefresh(v=>v+1);};
    const visible=()=>{if(document.hidden){setResult(null);setSelected(null);setExecuteConfirmed(false);}else update();};
    window.addEventListener('focus',update);document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const page=result?.kind==='ok'?result.value:null;
  const lastFilteredPage = Math.max(0, Math.ceil((page?.authorizations.length ?? 0) / pageSize) - 1);
  const visiblePage = Math.min(filteredPage, lastFilteredPage);
  const visibleApprovals = filter === 'all' ? page?.authorizations ?? []
    : page?.authorizations.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize) ?? [];
  const timestamp=(v:string)=>intl.formatDate(v,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'America/Bogota'})+' '+t('bogota');
  const reload=()=>{setResult(null);setRefresh(v=>v+1);};
  function changeFilter(value: ApprovalFilter) {
    setResult(null);
    setCursors([undefined]);
    setFilteredPage(0);
    setFilter(value);
  }
  async function run(work:()=>Promise<Outcome<unknown>>) {
    if(busy)return;setBusy(true);setError('');
    try{const value=await work();if(value.kind==='unauthenticated')onSessionLost();if(value.kind==='ok'){setConfirmed(false);setSelected(null);setExecuteConfirmed(false);reload();}else setError(value.kind);}
    catch{setError('unavailable');}
    finally{setBusy(false);}
  }
  const grant=()=>run(async()=>{
    if(!policy||!confirmed||!action||!uuid(reference)||(action!=='cancelled'&&!uuid(replacement)))return{kind:'invalid'};
    const payload={advisorReference:reference.toLowerCase(),action,replacementPolicyId:action==='cancelled'?null:replacement.toLowerCase(),expiresAt};
    const body=JSON.stringify(payload);if(command.current?.body!==body)command.current={body,key:crypto.randomUUID()};
    return grantApproval(policy.policyId,payload,command.current.key);
  });
  return <section className="card policy-section" aria-labelledby="advisor-heading">
    <div className="advisor-approval-header">
      <h2 id="advisor-heading" className="h-card">{t(policy ? 'authorizations' : 'pending')}</h2>
      <IconButton label={t('refresh')} icon="refresh" disabled={busy} onClick={reload} />
    </div>
    {policy && <label className="field advisor-approval-filter">{t('filterStatus')}
      <select value={filter} disabled={busy} onChange={event => changeFilter(event.target.value as ApprovalFilter)}>
        <option value="all">{t('allStatuses')}</option>
        {approvalStatuses.map(status => <option key={status} value={status}>{t(status === 'active' ? 'approved' : status)}</option>)}
      </select>
    </label>}
    {!result&&<p role="status">{t('loading')}</p>}
    {result&&result.kind!=='ok'&&<p role="alert">{t(result.kind)}</p>}
    {page&&<>
      {!visibleApprovals.length && <p role="status">{t(filter === 'all' ? 'empty' : 'filteredEmpty')}</p>}

      {policy ? visibleApprovals.length > 0 && <OwnerApprovalTable approvals={visibleApprovals} busy={busy} t={t} timestamp={timestamp}
        onRevoke={approval => void run(() => revokeApproval(approval))} /> : <ul className="policy-documents">{visibleApprovals.map(a=><li key={a.authorizationId}><div><p>{t('policy')}: <span className="mono">{a.policyId}</span></p><p>{t(a.action)} · {t(a.status)}</p>
        {a.replacementPolicyId&&<p className="mono">{t('replacement')}: {a.replacementPolicyId}</p>}<p>{t('expires')}: {timestamp(a.expiresAt)}</p>
        {a.revokedAt&&<p>{t('revoked')}: {timestamp(a.revokedAt)}</p>}
        {a.status==='active'&&<div className="check"><input id={'approve-'+a.authorizationId} type="checkbox" checked={selected===a.authorizationId&&executeConfirmed} disabled={busy}
          onChange={e=>{setSelected(a.authorizationId);setExecuteConfirmed(e.target.checked);}}/><label htmlFor={'approve-'+a.authorizationId}>{t('executeConfirm')}</label></div>}
      </div>{a.status==='active'&&<button type="button" className="btn btn-secondary btn-small" disabled={busy||selected!==a.authorizationId||!executeConfirmed||Date.parse(a.expiresAt)<=Date.now()} onClick={()=>void run(()=>{
          let key=executions.current.get(a.authorizationId);if(!key){key=crypto.randomUUID();executions.current.set(a.authorizationId,key);}return executeApproval(a,key);
        })}>{t('execute')}</button>}</li>)}</ul>}
      {filter === 'all' && <>
        {page.hasMore && <p className="note">{t('more')}</p>}
        {(cursors.length > 1 || page.nextCursor) && <div className="actions">
          {cursors.length > 1 && <button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setResult(null);setCursors(v=>v.slice(0,-1));}}>{t('previous')}</button>}
          {page.nextCursor && <button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setResult(null);setCursors(v=>[...v,page.nextCursor??undefined]);}}>{t('next')}</button>}
        </div>}
      </>}
      {filter !== 'all' && lastFilteredPage > 0 && <div className="actions">
        <button type="button" className="btn btn-secondary" disabled={busy || visiblePage === 0} onClick={() => setFilteredPage(visiblePage - 1)}>{t('previous')}</button>
        <button type="button" className="btn btn-secondary" disabled={busy || visiblePage === lastFilteredPage} onClick={() => setFilteredPage(visiblePage + 1)}>{t('next')}</button>
      </div>}
    </>}
    {policy&&!policy.lifecycle&&<details className="policy-management-disclosure">
      <summary>{t('newAuthorization')}</summary>
      <form onSubmit={event=>{event.preventDefault();void grant();}}>
      <p className="note">{t('scope')}</p><label className="field">{t('reference')}<input required value={reference} disabled={busy} onChange={e=>{setReference(e.target.value.trim());setConfirmed(false);}}/></label>
      <label className="field">{t('action')}<select value={action} disabled={busy} onChange={e=>{setAction(e.target.value as Approval['action']|'');setConfirmed(false);}}><option value="" disabled>{intl.formatMessage({id:'policies.lifecycle.choose'})}</option>{(['cancelled','modified','renewed'] as const).map(a=><option key={a} value={a}>{t(a)}</option>)}</select></label>
      {action&&action!=='cancelled'&&<label className="field">{t('replacement')}<input required value={replacement} disabled={busy} onChange={e=>{setReplacement(e.target.value.trim());setConfirmed(false);}}/></label>}
      <label className="field">{t('validity')}<select value={days} disabled={busy} onChange={e=>{const count=Number(e.target.value);setDays(count);setExpiresAt(validUntil(count));setConfirmed(false);}}>{[1,2,3,7].map(value=><option key={value} value={value}>{intl.formatMessage({id:'sale.days'},{count:value})}</option>)}</select></label>
      <div className="check"><input id="advisor-grant-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/><label htmlFor="advisor-grant-confirm">{t(action==='cancelled'?'confirmCancel':'confirm')}</label></div>
      <button className="btn btn-secondary" disabled={busy||!confirmed||!action} type="submit">{busy?t('saving'):t('grant')}</button>
      </form>
    </details>}
    {error&&<p role="alert">{t(error)}</p>}
  </section>;
}
export function AdvisorPortal({onSessionLost}:{onSessionLost():void}) {
  const intl=useIntl();
  const [reference,setReference]=useState<string|null>(null);
  return <main className="content policies"><div className="page-title"><span className="page-icon page-icon-violet" aria-hidden="true"><Icon name="advisor" size={22} /></span><h1>{intl.formatMessage({id:'advisor.console'})}</h1></div><AdvisorSale reference={reference} onSessionLost={onSessionLost}/><AdvisorActions onSessionLost={onSessionLost} onReference={setReference}/></main>;
}
