import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { executeApproval, grantApproval, readApprovals, revokeApproval, uuid, type Approval, type ApprovalList, type Outcome } from './api';
import type { PolicyDetail } from '../policies/api';
import { AdvisorSale } from '../sale/AdvisorSale';
import '../policies/policies.css';
import { Icon } from '../navigation/Icon';

export function AdvisorActions({policy,onSessionLost,onReference}:{policy?:PolicyDetail;onSessionLost():void;onReference?(reference:string):void}) {
  const intl=useIntl(),t=(key:string)=>intl.formatMessage({id:`advisor.${key}`});
  const [cursors,setCursors]=useState<(string|undefined)[]>([undefined]);
  const [result,setResult]=useState<Outcome<ApprovalList>|null>(null),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const advisorReference=result?.kind==='ok'?result.value.advisorReference:undefined;
  useEffect(()=>{if(advisorReference)onReference?.(advisorReference);},[advisorReference,onReference]);
  const [reference,setReference]=useState(''),[action,setAction]=useState<Approval['action']|''>(''),[replacement,setReplacement]=useState('');
  const validUntil=(count:number)=>new Date(Date.now()+count*86400000-300000).toISOString();
  const [days,setDays]=useState(1),[expiresAt,setExpiresAt]=useState(()=>validUntil(1)),[confirmed,setConfirmed]=useState(false);
  const [selected,setSelected]=useState<string|null>(null),[executeConfirmed,setExecuteConfirmed]=useState(false);
  const command=useRef<{body:string;key:string}|null>(null),executions=useRef(new Map<string,string>());
  useEffect(()=>{
    if(document.hidden)return;
    const abort=new AbortController();
    void readApprovals(policy?.policyId??null,abort.signal,cursors[cursors.length-1]).then(value=>{if(!abort.signal.aborted&&!document.hidden){if(value.kind==='unauthenticated')onSessionLost();setResult(value);}});
    return()=>abort.abort();
  },[policy?.policyId,refresh,onSessionLost,cursors]);
  useEffect(()=>{
    const update=()=>{setResult(null);setSelected(null);setExecuteConfirmed(false);setRefresh(v=>v+1);};
    const visible=()=>{if(document.hidden){setResult(null);setSelected(null);setExecuteConfirmed(false);}else update();};
    window.addEventListener('focus',update);document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const page=result?.kind==='ok'?result.value:null;
  const timestamp=(v:string)=>intl.formatDate(v,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'America/Bogota'})+' '+t('bogota');
  const reload=()=>{setResult(null);setRefresh(v=>v+1);};
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
    <h2 id="advisor-heading" className="h-card">{t(policy ? 'authorizations' : 'pending')}</h2>
    {!result&&<p role="status">{t('loading')}</p>}
    {result&&result.kind!=='ok'&&<p role="alert">{t(result.kind)}</p>}
    <button className="btn btn-secondary btn-small" type="button" disabled={busy} onClick={reload}>{t('refresh')}</button>
    {page&&<>
      {!page.authorizations.length&&<p>{t('empty')}</p>}

      <ul className="policy-documents">{page.authorizations.map(a=><li key={a.authorizationId}><div><p>{t('policy')}: <span className="mono">{a.policyId}</span></p><p>{t(a.action)} · {t(a.status)}</p>
        {a.replacementPolicyId&&<p className="mono">{t('replacement')}: {a.replacementPolicyId}</p>}<p>{t('expires')}: {timestamp(a.expiresAt)}</p>
        {a.revokedAt&&<p>{t('revoked')}: {timestamp(a.revokedAt)}</p>}
        {policy&&<p className="mono">{t('reference')}: {a.advisorReference}</p>}
        {!policy&&a.status==='active'&&<div className="check"><input id={'approve-'+a.authorizationId} type="checkbox" checked={selected===a.authorizationId&&executeConfirmed} disabled={busy}
          onChange={e=>{setSelected(a.authorizationId);setExecuteConfirmed(e.target.checked);}}/><label htmlFor={'approve-'+a.authorizationId}>{t('executeConfirm')}</label></div>}
      </div>{(policy?!a.revokedAt:a.status==='active')&&(policy?<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void run(()=>revokeApproval(a))}>{t('revoke')}</button>
        :<button type="button" className="btn btn-secondary btn-small" disabled={busy||selected!==a.authorizationId||!executeConfirmed||Date.parse(a.expiresAt)<=Date.now()} onClick={()=>void run(()=>{
          let key=executions.current.get(a.authorizationId);if(!key){key=crypto.randomUUID();executions.current.set(a.authorizationId,key);}return executeApproval(a,key);
        })}>{t('execute')}</button>)}</li>)}</ul>{page.hasMore&&<p className="note">{t('more')}</p>}<div className="actions">{cursors.length>1&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setResult(null);setCursors(v=>v.slice(0,-1));}}>{t('previous')}</button>}{page.nextCursor&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setResult(null);setCursors(v=>[...v,page.nextCursor??undefined]);}}>{t('next')}</button>}</div>
    </>}
    {policy&&!policy.lifecycle&&<form onSubmit={event=>{event.preventDefault();void grant();}}>
      <p className="note">{t('scope')}</p><label className="field">{t('reference')}<input required value={reference} disabled={busy} onChange={e=>{setReference(e.target.value.trim());setConfirmed(false);}}/></label>
      <label className="field">{t('action')}<select value={action} disabled={busy} onChange={e=>{setAction(e.target.value as Approval['action']|'');setConfirmed(false);}}><option value="" disabled>{intl.formatMessage({id:'policies.lifecycle.choose'})}</option>{(['cancelled','modified','renewed'] as const).map(a=><option key={a} value={a}>{t(a)}</option>)}</select></label>
      {action&&action!=='cancelled'&&<label className="field">{t('replacement')}<input required value={replacement} disabled={busy} onChange={e=>{setReplacement(e.target.value.trim());setConfirmed(false);}}/></label>}
      <label className="field">{t('validity')}<select value={days} disabled={busy} onChange={e=>{const count=Number(e.target.value);setDays(count);setExpiresAt(validUntil(count));setConfirmed(false);}}>{[1,2,3,7].map(value=><option key={value} value={value}>{intl.formatMessage({id:'sale.days'},{count:value})}</option>)}</select></label>
      <div className="check"><input id="advisor-grant-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/><label htmlFor="advisor-grant-confirm">{t(action==='cancelled'?'confirmCancel':'confirm')}</label></div>
      <button className="btn btn-secondary" disabled={busy||!confirmed||!action} type="submit">{busy?t('saving'):t('grant')}</button>
    </form>}
    {error&&<p role="alert">{t(error)}</p>}
  </section>;
}
export function AdvisorPortal({onSessionLost}:{onSessionLost():void}) {
  const intl=useIntl();
  const [reference,setReference]=useState<string|null>(null);
  return <main className="content policies"><div className="page-title"><span className="page-icon page-icon-violet" aria-hidden="true"><Icon name="advisor" size={22} /></span><h1>{intl.formatMessage({id:'advisor.console'})}</h1></div><AdvisorSale reference={reference} onSessionLost={onSessionLost}/><AdvisorActions onSessionLost={onSessionLost} onReference={setReference}/></main>;
}
