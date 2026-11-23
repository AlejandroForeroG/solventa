import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { caseCommand, getCase, getExperts, getOwnedCases, prepareRequirementFile, selectRequirementFiles, sendRequirementFile, type CaseAudience, type CaseRecord, type Expert, type OwnedCase } from './case-api';
import '../audit/audit.css';
import '../policies/policies.css';
import './claims.css';
import { ClaimDisbursement } from './ClaimDisbursement';
import { OwnClaimPayments } from './OwnClaimPayments';
import { Icon, type IconName } from '../navigation/Icon';
import { keepMeridiem } from '../i18n/I18n';

type ViewTab = 'overview' | 'documents' | 'tasks' | 'history';
type AnalystAction = 'approve' | 'reject' | 'assign_expert' | 'request_information' | 'extend_requirement';
type CaseProps = { claimId: string; audience: CaseAudience; onSessionLost(): void };

function useClaimLabels() {
  const intl = useIntl();
  return (name: string, values?: Record<string, string | number>) => intl.formatMessage({ id: `claims.${name}` }, values);
}

export function CustomerClaims({ onSessionLost }: { onSessionLost(): void }) {
  const t = useClaimLabels();
  const [claims, setClaims] = useState<OwnedCase[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void getOwnedCases(abort.signal).then(result => {
      if (abort.signal.aborted) return;
      if (result.kind === 'unauthenticated') onSessionLost();
      if (result.kind === 'ok') setClaims(result.value.items);
      else setError(result.kind);
    });
    return () => abort.abort();
  }, [onSessionLost, revision]);

  return <main className="audit-main claim-case">
    <div className="page-title"><span className="page-icon page-icon-blue" aria-hidden="true"><Icon name="claims" size={22} /></span><h1>{t('customerCases')}</h1></div>
    <section className="card report-in-app" aria-labelledby="report-in-app-title">
      <span className="icon-chip" aria-hidden="true"><Icon name="phone" size={20} /></span>
      <div><h2 id="report-in-app-title" className="h-card">{t('reportInApp.title')}</h2>
      <p className="note">{t('reportInApp.body')}</p></div>
    </section>
    {error && <div role="alert" className="banner banner-error claims-banner"><Icon name="alert" size={18} className="banner-icon" /><p>{t('caseError.' + error)}</p><button type="button" className="btn btn-secondary btn-small" onClick={() => { setError(''); setRevision(n => n + 1); }}><Icon name="refresh" size={16} />{t('retry')}</button></div>}
    {!claims && !error && <p role="status">{t('loading')}</p>}
    {claims?.length === 0 && <div className="card empty-state"><span className="empty-state-art" aria-hidden="true"><Icon name="claims" size={30} /></span><h2>{t('customerEmpty')}</h2></div>}
    {claims && claims.length > 0 && <ul className="own-claims">{claims.map(claim => <li key={claim.claimId}>
      <a className="card own-claim" href={'/mis-siniestros/' + claim.claimId}>
        <span className="icon-chip icon-chip-blue" aria-hidden="true"><Icon name="claims" size={20} /></span>
        <span className="mono own-claim-number">{claim.claimNumber}</span>
        <span className={'claims-badge claims-state-' + claim.state}>{t((claim.state === 'unassigned' ? 'customerState.' : 'state.') + claim.state)}</span>
        <span className="own-claim-open" aria-hidden="true">{t('openCase')}<Icon name="arrow" size={16} /></span>
      </a>
    </li>)}</ul>}
    <OwnClaimPayments onSessionLost={onSessionLost} />
  </main>;
}

export function ClaimCase({ claimId, audience, onSessionLost }: CaseProps) {
  const t = useClaimLabels();
  const intl = useIntl();
  const [claim, setClaim] = useState<CaseRecord>();
  const [error, setError] = useState('');
  const [trace, setTrace] = useState('');
  const [updating, setUpdating] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<ViewTab>(() =>
    audience === 'customer' && new URLSearchParams(window.location.search).get('section') === 'tasks' ? 'tasks' : 'overview');
  const refresh = (action: string) => { setConfirmation(action); setUpdating(true); setRevision(n => n + 1); };
  useEffect(() => {
    const abort = new AbortController();
    void getCase(claimId, audience, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      if (result.kind === 'unauthenticated') onSessionLost();
      setUpdating(false);
      if (result.kind === 'ok') { setClaim(result.value); setError(''); setTrace(''); }
      else { setClaim(undefined); setError(result.kind); setTrace(result.traceId ?? ''); }
    });
    return () => abort.abort();
  }, [claimId, audience, onSessionLost, revision]);

  const clock = (value: string) => keepMeridiem(intl.formatDate(value, { year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })) + ' ' + t('bogota');
  const tabs: ViewTab[] = ['overview', 'documents', 'tasks', 'history'];
  const download = (id: string) => '/api/v1/claims/' + claimId + '/' + audience + '/files/' + id;
  return <main className="audit-main claim-case">
    {error !== 'not_found' && <a className="btn btn-secondary btn-small back-link" href={audience === 'case' ? '/siniestros' : '/mis-siniestros'}><Icon name="back" size={16} />{t('caseBack')}</a>}
    {error && <div role="alert" className="audit-state"><p>{t('caseError.' + (error === 'not_found' && audience === 'case' ? 'not_found_case' : error))}</p>
      {error === 'not_found' ? <a className="btn btn-secondary" href={audience === 'case' ? '/siniestros' : '/mis-siniestros'}>{t('caseBack')}</a>
        : <button type="button" className="btn btn-secondary" onClick={() => { setError(''); setRevision(n => n + 1); }}>{t('retry')}</button>}
      {trace && <details className="audit-reference-details"><summary>{t('supportDetails')}</summary><span className="mono">{trace}</span></details>}</div>}
    {!claim && !error && <p role="status">{t('loading')}</p>}
    {claim && <>
      <header className="claim-case-heading"><span className="page-icon page-icon-blue" aria-hidden="true"><Icon name="claims" size={22} /></span><h1>{intl.formatMessage({ id: 'claims.caseTitle' }, { number: <span className="nowrap">{claim.claimNumber}</span> })}</h1>
        <span className={'claims-badge claims-state-' + claim.state}>{t((audience === 'customer' && claim.state === 'unassigned' ? 'customerState.' : 'state.') + claim.state)}</span></header>
      {confirmation && <p role="status" className="claim-confirmation"><Icon name="check" size={18} />{t('ack.' + confirmation)}</p>}
      {updating ? <p role="status">{t('loading')}</p> : claim.access === 'unassigned' ? <div className="claim-case-grid">
        <section className="case-card" aria-labelledby="claim-preview-title"><h2 id="claim-preview-title">{t('preview')}</h2>
          <dl className="case-fields">
            <div><dt><Icon name="policy" size={16} />{t('col.policy')}</dt><dd className="mono">POL-{claim.policyId.slice(0, 8).toUpperCase()}</dd></div>
            <div><dt><Icon name="calendar" size={16} />{t('occurred')}</dt><dd>{clock(claim.occurredAt)}</dd></div>
            {claim.eventType && <div><dt><Icon name="alert" size={16} />{t('eventType')}</dt><dd>{t('event.' + claim.eventType)}</dd></div>}
            <div><dt><Icon name="paperclip" size={16} />{t('col.evidence')}</dt><dd>{claim.requiredEvidence ? t('evidenceRequired', { required: claim.requiredEvidence }) : t('noEvidenceRequired')}</dd></div>
          </dl>
        </section>
        <AnalystActions claimId={claimId} claim={claim} onSessionLost={onSessionLost} onDone={refresh} />
      </div> : <>
        <div role="tablist" className="policy-tabs" aria-label={t('caseSections')}>
          {tabs.map(section => <button key={section} type="button" role="tab" id={`claim-tab-${section}`} aria-selected={tab === section} aria-controls="claim-tab-panel" tabIndex={tab === section ? 0 : -1}
            onClick={() => setTab(section)} onKeyDown={event => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              const next = tabs[(tabs.indexOf(section) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              setTab(next); document.getElementById(`claim-tab-${next}`)?.focus();
            }}>{t('section.' + section)}</button>)}
        </div>
        <div className="claim-case-grid">
          <section className="case-card" role="tabpanel" id="claim-tab-panel" aria-labelledby={`claim-tab-${tab}`}>
            <h2>{t('section.' + tab)}</h2>
            {tab === 'overview' && audience === 'customer' && claim.requirements.some(item => item.status === 'pending' && Date.parse(item.deadline) > Date.now()) && <div className="banner banner-info case-pending-task" role="status">
              <Icon name="info" size={18} className="banner-icon" /><p><strong>{t('pendingTask')}</strong> {t('pendingTaskDetail')}</p>
              <button type="button" className="btn btn-primary btn-small" onClick={() => { setTab('tasks'); document.getElementById('claim-tab-tasks')?.focus(); }}>{t('openTasks')}<Icon name="arrow" size={16} /></button>
            </div>}
            {tab === 'overview' && <><dl className="case-fields">
              <div><dt><Icon name="policy" size={16} />{t('col.policy')}</dt><dd><span className="mono">POL-{claim.policyId.slice(0, 8).toUpperCase()}</span><details className="claims-policy-reference"><summary>{t('fullPolicyId')}</summary><span className="mono">{claim.policyId}</span></details></dd></div>
              <div><dt><Icon name="calendar" size={16} />{t('occurred')}</dt><dd>{clock(claim.occurredAt)}</dd></div>
              {claim.eventType && <div><dt><Icon name="alert" size={16} />{t('eventType')}</dt><dd>{t('event.' + claim.eventType)}</dd></div>}
              {claim.place && <div><dt><Icon name="location" size={16} />{t('place')}</dt><dd>{claim.place}</dd></div>}
            </dl>{claim.description && <p className="case-note">{claim.description}</p>}
            <h3>{t('caseNotices')}</h3>
            {claim.notices.length === 0 && <p className="empty-inline"><Icon name="info" size={18} />{t('noNotices')}</p>}
            <ul className="case-list">{claim.notices.map(notice => <li key={notice.id}><span className="icon-label"><Icon name="check" size={16} />{t('ack.' + notice.action)}</span><time dateTime={notice.at}>{clock(notice.at)}</time></li>)}</ul></>}
            {tab === 'documents' && <>{claim.evidence.length === 0 && <p className="empty-inline"><Icon name="file" size={18} />{t('noDocuments')}</p>}
              <ul className="case-list case-files">{claim.evidence.map((file, i) => <li key={file.id}>
                <span className="icon-chip icon-chip-sm icon-chip-slate" aria-hidden="true"><Icon name="file" size={16} /></span>
                <a href={download(file.id)}>{t('documentNumber', { number: i + 1 })}</a><span className="note">{file.contentType} · {intl.formatNumber(file.byteSize / 1024, { maximumFractionDigits: 1 })} KB</span>
              </li>)}</ul></>}
            {tab === 'tasks' && <>
              {!claim.requirements.length && !claim.history.some(item => item.expert) && <p className="empty-inline"><Icon name="check" size={18} />{t('noTasks')}</p>}
              {claim.history.filter(item => item.expert).map(item => <article key={item.id} className="case-task">
                <h3 className="case-task-title"><span className="icon-chip icon-chip-sm icon-chip-violet" aria-hidden="true"><Icon name="user" size={16} /></span>{t('action.assign_expert')}</h3><p>{item.expert?.name}</p><p>{item.reason}</p><time dateTime={item.at}>{clock(item.at)}</time>
              </article>)}
              {claim.requirements.map(item => <article key={item.id} className="case-task">
                <h3 className="case-task-title"><span className="icon-chip icon-chip-sm icon-chip-amber" aria-hidden="true"><Icon name="info" size={16} /></span>{t('requirement')} · {t('requirement.' + item.status)}</h3><p className="case-note">{item.details}</p>
                <dl className="case-fields"><div><dt><Icon name="user" size={16} />{t('recipient')}</dt><dd>{t('owner')}</dd></div><div><dt><Icon name="clock" size={16} />{t('deadline')}</dt><dd>{clock(item.deadline)}</dd></div></dl>
                {item.responseText && <p className="case-note">{item.responseText}</p>}
                {item.evidenceIds.map((id, i) => <p key={id}><a href={download(id)}>{t('documentNumber', { number: i + 1 })}</a></p>)}
                {audience === 'customer' && item.status === 'pending' && Date.parse(item.deadline) > Date.now()
                  && <RequirementForm key={item.id} claimId={claimId} requirementId={item.id} onDone={refresh} onSessionLost={onSessionLost} />}
                {item.status === 'pending' && Date.parse(item.deadline) <= Date.now() && <p className="banner banner-error"><Icon name="clock" size={18} className="banner-icon" /><span>{t('deadlinePassed')}</span></p>}
              </article>)}
            </>}
            {tab === 'history' && <ol className="case-history case-timeline">{claim.history.map(item => <li key={item.id}>
              <strong>{t(audience === 'customer' && item.action !== 'submitted' ? 'ack.' + item.action : 'action.' + item.action)}</strong> <time dateTime={item.at}>{clock(item.at)}</time>
              {item.reason && <p className="case-note">{item.reason}</p>}
              {item.expert && <p>{item.expert.name}</p>}
              {item.actorId && <p className="mono audit-id">{t('actor')} · {item.actorId}</p>}
            </li>)}</ol>}
          </section>
          {claim.access === 'assigned' && (claim.state === 'approved' || claim.state === 'paid'
            ? <ClaimDisbursement key={claimId} claimId={claimId} paid={claim.state === 'paid'} onSessionLost={onSessionLost} onConfirmed={() => refresh('disbursement_confirmed')} />
            : <AnalystActions claimId={claimId} claim={claim} onDone={refresh} onSessionLost={onSessionLost} />)}
          {claim.access === 'customer' && tab === 'overview' && (claim.state === 'approved' || claim.state === 'paid')
            && <OwnClaimPayments key={claimId} claimId={claimId} onSessionLost={onSessionLost} />}
        </div>
      </>}
    </>}
  </main>;
}

type ActionProps = { claimId: string; onDone(action: string): void; onSessionLost(): void };
const actionIcon: Record<AnalystAction, IconName> = { approve: 'check', reject: 'close', assign_expert: 'user', request_information: 'send', extend_requirement: 'clock' };
function AnalystActions({ claim, claimId, onDone, onSessionLost }: ActionProps & { claim: CaseRecord }) {
  const t = useClaimLabels();
  const [action, setAction] = useState<AnalystAction>();
  const [reason, setReason] = useState('');
  const [deadline, setDeadline] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [expertId, setExpertId] = useState('');
  const [experts, setExperts] = useState<Expert[]>([]);
  const [directoryError, setDirectoryError] = useState(false);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ payload: string; key: string } | undefined>(undefined);
  const locked = useRef(false);
  useEffect(() => {
    if (action !== 'assign_expert') return;
    const abort = new AbortController();
    void getExperts(abort.signal).then(result => {
      if (abort.signal.aborted) return;
      if (result.kind === 'unauthenticated') onSessionLost();
      if (result.kind === 'ok') setExperts(result.value.experts);
      else setDirectoryError(true);
    });
    return () => abort.abort();
  }, [action, onSessionLost, directoryRevision]);

  const decision = action === 'approve' || action === 'reject';
  const blocked = claim.evidence.length < Math.max(1, claim.requiredEvidence);
  const reviewable = claim.state === 'in_review' || claim.state === 'escalated';
  const expiredRequirement = claim.state === 'pending_information' && claim.requirements.find(item => item.status === 'pending' && Date.parse(item.deadline) <= Date.now());
  if (!reviewable && !expiredRequirement && claim.access !== 'unassigned') return null;
  const assignedExpert = claim.history.some(item => item.expert);
  const options: AnalystAction[] = expiredRequirement ? ['extend_requirement'] : assignedExpert ? ['approve', 'reject', 'request_information'] : ['approve', 'reject', 'request_information', 'assign_expert'];
  async function submit(chosen: AnalystAction | 'take') {
    if (locked.current) return;
    const date = new Date(deadline + '-05:00');
    if ((chosen === 'request_information' || chosen === 'extend_requirement') && (!(date.getTime() > Date.now()) || reason.trim().length < 10)) { setError('invalid'); return; }
    if (chosen === 'extend_requirement' && !expiredRequirement) { setError('conflict'); return; }
    const path = chosen === 'approve' || chosen === 'reject' ? 'decisions' : 'review';
    const payload = chosen === 'take' ? { action: chosen } : chosen === 'assign_expert' ? { action: chosen, expertId, reason }
      : chosen === 'request_information' ? { action: chosen, details: reason, deadline: date.toISOString() }
        : chosen === 'extend_requirement' && expiredRequirement ? { action: chosen, requirementId: expiredRequirement.id, reason, deadline: date.toISOString() }
          : { action: chosen, reason, evidenceIds: selected };
    const serialized = JSON.stringify(payload);
    if (pending.current?.payload !== serialized) pending.current = { payload: serialized, key: crypto.randomUUID() };
    locked.current = true; setBusy(true); setError('');
    try {
      const result = await caseCommand(claimId, path, payload, pending.current.key);
      if (result.kind === 'ok') { setAction(undefined); setReason(''); setDeadline(''); setSelected([]); setExpertId(''); pending.current = undefined; onDone(chosen); }
      else if (result.kind === 'unauthenticated') onSessionLost();
      else setError(result.kind);
    } finally { locked.current = false; setBusy(false); }
  }
  return <aside className="case-card claim-actions">
    <h2>{t('actions')}</h2>
    {claim.access === 'unassigned' ? <><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit('take')}><Icon name="user" size={18} />{t('action.take')}</button></>
      : <div className="case-action-options">{options.map(option => <button key={option} type="button" className={`btn ${option === 'approve' ? 'btn-primary' : option === 'reject' ? 'btn-danger case-action-reject' : 'btn-secondary'}`}
        aria-pressed={action === option} disabled={busy || (blocked && (option === 'approve' || option === 'reject'))}
        onClick={() => { setAction(option); setReason(''); setSelected([]); setError(''); setDirectoryError(false); }}><Icon name={actionIcon[option]} size={18} />{t('action.' + option)}</button>)}</div>}
    {blocked && claim.access !== 'unassigned' && <p className="note icon-label"><Icon name="alert" size={16} />{t('missingEvidence')}</p>}
    {action && <form onSubmit={event => { event.preventDefault(); void submit(action); }}>
      <label className="field">{t(action === 'request_information' ? 'requiredDetails' : 'reason')}
        <textarea value={reason} onChange={event => setReason(event.target.value)} disabled={busy} minLength={10} maxLength={1000} required />
      </label>
      {decision && <fieldset className="case-evidence-choice"><legend className="field-label">{t('section.documents')}</legend>{claim.evidence.slice(0, 20).map((file, i) => <label className="case-checkbox" key={file.id}>
        <input type="checkbox" disabled={busy} checked={selected.includes(file.id)}
          onChange={event => setSelected(items => event.target.checked ? [...items, file.id] : items.filter(id => id !== file.id))} />
        {t('documentNumber', { number: i + 1 })}
      </label>)}</fieldset>}
      {action === 'assign_expert' && <label className="field">{t('expert')}
        <select value={expertId} required disabled={busy || directoryError} onChange={event => setExpertId(event.target.value)}>
          <option value="">{t('chooseExpert')}</option>{experts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {directoryError && <button className="btn btn-secondary" type="button" onClick={() => { setDirectoryError(false); setDirectoryRevision(n => n + 1); }}>{t('retry')}</button>}
      </label>}
      {(action === 'request_information' || action === 'extend_requirement') && <>
        <p>{t('recipient')} · {t('owner')}</p><label className="field">{t('deadline')}<input type="datetime-local" required value={deadline} disabled={busy} onChange={event => setDeadline(event.target.value)} /></label>
      </>}
      <button className={`btn ${action === 'reject' ? 'btn-danger' : 'btn-primary'}`} type="submit" disabled={busy || (decision && selected.length === 0)}><Icon name={actionIcon[action]} size={18} />{t('submit.' + action)}</button>
    </form>}
    {error && <p role="alert" className="claims-error icon-label"><Icon name="alert" size={16} />{t('caseError.' + error)}</p>}
  </aside>;
}

const fileTypes = ['image/jpeg', 'image/png', 'image/heic', 'video/mp4', 'video/quicktime'];
function RequirementForm({ claimId, requirementId, onDone, onSessionLost }: ActionProps & { requirementId: string }) {
  const t = useClaimLabels();
  const [answer, setAnswer] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ payload: string; key: string } | undefined>(undefined);
  const locked = useRef(false);
  const valid = answer.trim().length > 0 || files.length > 0;
  async function send() {
    if (locked.current || !valid) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const prepared = await Promise.all(files.map(file => prepareRequirementFile(requirementId, file)));
      if (new Set(prepared.map(file => file.id)).size !== prepared.length) { setError('invalid'); return; }
      const selection = await selectRequirementFiles(claimId, requirementId, prepared.map(file => file.id));
      if (selection.kind === 'unauthenticated') { onSessionLost(); return; }
      if (selection.kind !== 'ok') { setError(selection.kind); return; }
      for (const { id, sha256, file } of prepared) {
        const result = await sendRequirementFile(claimId, requirementId, id, file, sha256);
        if (result.kind === 'unauthenticated') { onSessionLost(); return; }
        if (result.kind !== 'ok') { setError(result.kind); return; }
      }
      const body = { text: answer, evidenceIds: prepared.map(file => file.id) };
      const payload = JSON.stringify(body);
      if (pending.current?.payload !== payload) pending.current = { payload, key: crypto.randomUUID() };
      const result = await caseCommand(claimId, 'requirements/' + requirementId + '/response', body, pending.current.key);
      if (result.kind === 'ok') onDone('respond');
      else if (result.kind === 'unauthenticated') onSessionLost();
      else setError(result.kind);
    } catch { setError('unavailable'); }
    finally { locked.current = false; setBusy(false); }
  }

  return <form className="requirement-form" onSubmit={event => { event.preventDefault(); void send(); }}>
    <label>{t('response')}<textarea value={answer} maxLength={2000} disabled={busy} onChange={event => setAnswer(event.target.value)} /></label>
    <label className="file-picker">{t('selectFiles')}<span className="btn btn-secondary btn-small file-picker-button" aria-hidden="true"><Icon name="paperclip" size={16} />{t('chooseFiles')}</span><input className="file-picker-input" type="file" multiple accept={fileTypes.join(',')} disabled={busy} onChange={event => {
      const selected = Array.from(event.target.files ?? []);
      if (selected.length > 3 || selected.some(file => !fileTypes.includes(file.type) || file.size === 0)
        || selected.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) { setError('invalid'); event.target.value = ''; return; }
      setError(''); setFiles(selected);
    }} /></label>
    <p className="note file-picker-state">{files.length ? t('filesSelected', { count: files.length }) : t('noFiles')}</p>
    {files.length > 0 && <ul className="case-list case-files">{files.map(file => <li key={file.name + ':' + file.lastModified + ':' + file.size}><span className="icon-label"><Icon name="file" size={16} />{file.name}</span></li>)}</ul>}
    <button className="btn btn-primary" type="submit" disabled={busy || !valid} aria-describedby={!valid ? 'requirement-hint' : undefined}><Icon name="send" size={18} />{t('sendResponse')}</button>
    {!valid && <p id="requirement-hint" className="note icon-label"><Icon name="info" size={16} />{t('responseHint')}</p>}
    {error && <p role="alert" className="claims-error icon-label"><Icon name="alert" size={16} />{t('caseError.' + error)}</p>}
  </form>;
}
