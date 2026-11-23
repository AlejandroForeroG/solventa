import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { fetchWithSession } from '../session-fetch';
import { changePolicyLifecycle, listPolicies, type LifecycleCommand, type PolicyDetail, type PolicySummary } from './api';

type Action = 'modified' | 'renewed' | 'cancelled';
const actions: Action[] = ['modified', 'renewed', 'cancelled'];
export function LifecycleActions({ policy, initialAction, onChanged, onSessionLost }: { policy: PolicyDetail; initialAction?: Action; onChanged(): void; onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `policies.lifecycle.${key}` });
  const [action, setAction] = useState<Action | ''>(initialAction ?? '');
  const [replacement, setReplacement] = useState('');
  const [choices, setChoices] = useState<PolicySummary[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choiceState, setChoiceState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const command = useRef<{ body: string; key: string } | null>(null);
  const expired = Date.now() >= Date.parse(policy.effectiveUntil);
  const eligible = action === 'cancelled' || (action === 'renewed' ? expired : action === 'modified' && !expired);
  const shortId = (id: string) => `POL-${id.slice(0, 8).toUpperCase()}`;
  const money = (value: string) => intl.formatNumber(Number(value), { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  useEffect(() => {
    if (!eligible || !action || action === 'cancelled') return;
    setChoiceState('loading');
    const controller = new AbortController();
    void (async () => {
      const found: PolicySummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result = await listPolicies(controller.signal, cursor === undefined ? undefined : { cursor });
        if (controller.signal.aborted) return;
        if (result.kind === 'unauthenticated') { onSessionLost(); return; }
        if (result.kind !== 'ok') { setChoiceState('failed'); return; }
        found.push(...result.value.policies);
        if (!result.value.hasMore || !result.value.nextCursor) break;
        cursor = result.value.nextCursor;
      }
      setChoices(found.filter(item => item.policyId !== policy.policyId && !item.contractStatus && item.product === policy.product)); setChoiceState('ready');
    })().catch(() => { if (!controller.signal.aborted) setChoiceState('failed'); });
    return () => controller.abort();
  }, [action, eligible, policy.policyId, policy.product, onSessionLost]);
  async function submit() {
    if (!confirmed || busy || !eligible || !action) return;
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
  return <>
    <div className="field"><label htmlFor="lifecycle-operation">{t('operation')}</label><select id="lifecycle-operation" value={action} disabled={busy} onChange={event => { setAction(event.target.value as Action | ''); setConfirmed(false); setError(''); }}>
      <option value="" disabled>{t('choose')}</option>
      {actions.map(value => <option key={value} value={value}>{t(value)}</option>)}
    </select></div>
    {action && !eligible && <p role="status">{t(action === 'renewed' ? 'renewAfterExpiry' : 'modifyBeforeExpiry')}</p>}
    {action && action !== 'cancelled' && eligible && <><p>{t('prepare')}</p><p><a href="/cotizar">{t('quote')}</a></p>
      {choiceState === 'loading' && <p role="status">{t('loading')}</p>}
      {choiceState === 'ready' && (choices.length ? <fieldset className="replacement-choices"><legend className="field-label">{t('replacement')}</legend>
        {choices.map(item => <label key={item.policyId} className="replacement-choice">
          <input type="radio" name="lifecycle-replacement" value={item.policyId} checked={replacement === item.policyId} disabled={busy} onChange={() => { setReplacement(item.policyId); setConfirmed(false); }} />
          <span><strong className="mono">{shortId(item.policyId)}</strong>
            <span className="note">{intl.formatDate(item.effectiveFrom, { dateStyle: 'medium' })} – {intl.formatDate(item.effectiveUntil, { dateStyle: 'medium' })} · {money(item.premium)}</span></span>
        </label>)}
      </fieldset> : <p className="note" role="status">{t('noReplacements')}</p>)}
      {choiceState === 'failed' && <><p role="status">{t('choicesFailed')}</p>
        <div className="field"><label htmlFor="lifecycle-replacement">{t('replacement')}</label><input id="lifecycle-replacement" className="mono-input" value={replacement} disabled={busy} onChange={event => { setReplacement(event.target.value.trim()); setConfirmed(false); }} placeholder="00000000-0000-4000-8000-000000000000" /></div></>}
    </>}
    {action && <><p>{action === 'cancelled' ? t('cancelEffect') : t('noRefund')}</p>
      <div className="check"><input id="lifecycle-confirm" type="checkbox" checked={confirmed} disabled={busy || !eligible} onChange={event => setConfirmed(event.target.checked)} /><label htmlFor="lifecycle-confirm">{t('confirm')}</label></div></>}
    {error && <p role="alert">{t(error)}</p>}
    {action && <div className="actions"><button type="button" className={`btn ${action === 'cancelled' ? 'btn-danger' : 'btn-primary'}`} disabled={!eligible || !confirmed || busy || action !== 'cancelled' && !replacement}
      onClick={() => void submit()}>{busy ? t('saving') : t(`submit.${action}`)}</button></div>}
  </>;
}
