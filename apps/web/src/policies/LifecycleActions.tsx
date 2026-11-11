import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { fetchWithSession } from '../session-fetch';
import { changePolicyLifecycle, listPolicies, type LifecycleCommand, type PolicyDetail, type PolicySummary } from './api';

type Action = 'modified' | 'renewed' | 'cancelled';
const actions: Action[] = ['modified', 'renewed', 'cancelled'];
export function LifecycleActions({ policy, onChanged, onSessionLost }: { policy: PolicyDetail; onChanged(): void; onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `policies.lifecycle.${key}` });
  const [action, setAction] = useState<Action>('cancelled');
  const [replacement, setReplacement] = useState('');
  const [choices, setChoices] = useState<PolicySummary[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choiceState, setChoiceState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const command = useRef<{ body: string; key: string } | null>(null);
  const expired = Date.now() >= Date.parse(policy.effectiveUntil);
  const eligible = action === 'cancelled' || (action === 'renewed' ? expired : !expired);
  useEffect(() => {
    const controller = new AbortController();
    void listPolicies(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.kind === 'ok') { setChoices(result.value.policies.filter(item => item.policyId !== policy.policyId && !item.contractStatus && item.product === policy.product)); setChoiceState('ready'); }
      else if (result.kind === 'unauthenticated') onSessionLost();
      else setChoiceState('failed');
    }).catch(() => { if (!controller.signal.aborted) setChoiceState('failed'); });
    return () => controller.abort();
  }, [policy.policyId, policy.product, onSessionLost]);
  async function submit() {
    if (!confirmed || busy || !eligible) return;
    setBusy(true); setError('');
    try {
      const read = await fetchWithSession(`/api/v1/policies/${policy.policyId}`, { cache: 'no-store' });
      if (read.status === 401) { onSessionLost(); return; }
      const current: unknown = await read.json();
      if (!read.ok || !current || typeof current !== 'object' || !('documentHash' in current) || typeof current.documentHash !== 'string') throw Error('read_failed');
      const payload: LifecycleCommand = { action, replacementPolicyId: action === 'cancelled' ? null : replacement,
        documentHash: current.documentHash, reason: action === 'modified' ? 'coverage_change' : action === 'renewed' ? 'term_renewal' : 'customer_request' };
      const body = JSON.stringify(payload);
      if (!command.current || command.current.body !== body) command.current = { body, key: crypto.randomUUID() };
      const result = await changePolicyLifecycle(policy.policyId, payload, command.current.key);
      if (result === 'unauthenticated') { onSessionLost(); return; }
      if (result === 'confirmed') { onChanged(); return; }
      setError(result);
    } catch { setError('uncertain'); }
    finally { setBusy(false); }
  }
  if (policy.lifecycle) return <section className="card policy-section" aria-labelledby="lifecycle-title">
    <h2 id="lifecycle-title" className="h-card">{t('history')}</h2><p role="status">{intl.formatMessage({ id: `policies.state.${policy.lifecycle.action}` })}: {intl.formatDate(policy.lifecycle.at)}.</p>
    <p>{t('reason')}: {['customer_request', 'coverage_change', 'term_renewal'].includes(policy.lifecycle.reason) ? t(policy.lifecycle.reason) : policy.lifecycle.reason}</p>{policy.lifecycle.replacementPolicyId && <p className="mono">{t('replacement')}: {policy.lifecycle.replacementPolicyId}</p>}
    <p>{t('recorded')}</p>
  </section>;
  return <section className="card policy-section" aria-labelledby="lifecycle-title"><h2 id="lifecycle-title" className="h-card">{t('manage')}</h2>
    <div className="field"><label htmlFor="lifecycle-operation">{t('operation')}</label><select id="lifecycle-operation" value={action} disabled={busy} onChange={event => { setAction(event.target.value as Action); setConfirmed(false); }}>
      {actions.map(value => <option key={value} value={value}>{t(value)}</option>)}
    </select></div>
    {!eligible && <p role="status">{t(action === 'renewed' ? 'renewAfterExpiry' : 'modifyBeforeExpiry')}</p>}
    {action !== 'cancelled' && eligible && <><p>{t('prepare')}</p><p><a href="/cotizar">{t('quote')}</a></p>
      {choiceState === 'loading' && <p role="status">{t('loading')}</p>}
      {choiceState === 'failed' && <p role="status">{t('choicesFailed')}</p>}
      <div className="field"><label htmlFor="lifecycle-replacement">{t('replacement')}</label><input id="lifecycle-replacement" className="mono-input" list="replacement-policies" value={replacement} disabled={busy} onChange={event => { setReplacement(event.target.value.trim()); setConfirmed(false); }} placeholder="00000000-0000-4000-8000-000000000000" /></div>
      <datalist id="replacement-policies">{choices.map(item => <option key={item.policyId} value={item.policyId} />)}</datalist>
      <p className="note">{t('replacementHint')}</p></>}
    <p>{t('noRefund')}</p>
    <div className="check"><input id="lifecycle-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><label htmlFor="lifecycle-confirm">{t('confirm')}</label></div>
    {error && <p role="alert">{t(error)}</p>}
    <div className="actions"><button type="button" className="btn btn-secondary" disabled={!eligible || !confirmed || busy || action !== 'cancelled' && !replacement}
      onClick={() => void submit()}>{busy ? t('saving') : t(action)}</button></div>
  </section>;
}
