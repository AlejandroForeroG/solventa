import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { useAnnounce } from './Live';
import { estimateFields, invalidEstimateFields, requestEstimate, type Estimate, type EstimateField, type EstimateValues } from './estimate-api';
import { clearEstimateDraft, saveEstimateDraft } from './estimate-draft';

export function PublicQuoteFlow({ initialValues, onValuesChange }: { initialValues: EstimateValues | null; onValuesChange?: (values: EstimateValues) => void }) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const { cop } = useFormatters();
  const announce = useAnnounce();
  const [values, setValues] = useState<EstimateValues>(initialValues ?? { ageYears: '', amount: '', termMonths: '' });
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [phase, setPhase] = useState<'form' | 'result' | 'login'>('form');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<EstimateField[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => { heading.current?.focus(); }, [phase]);

  async function calculate() {
    if (busy) return;
    const errors = invalidEstimateFields(values);
    setInvalid(errors); setUnavailable(false);
    if (errors.length) { document.getElementById(`estimate-${errors[0]}`)?.focus(); announce(t('estimate.invalid')); return; }
    setBusy(true);
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    announce(t('live.calculating'));
    try {
      const outcome = await requestEstimate(values, controller.signal);
      if (controller.signal.aborted) return;
      if (outcome.kind === 'estimate') { setEstimate(outcome.estimate); setPhase('result'); announce(intl.formatMessage({ id: 'live.quoteReady' }, { premium: cop(outcome.estimate.premiumMonthly) })); }
      else if (outcome.kind === 'invalid') { setInvalid(outcome.fields); document.getElementById(`estimate-${outcome.fields[0]}`)?.focus(); announce(t('estimate.invalid')); }
      else { setUnavailable(true); announce(t('live.unavailable')); }
    } catch { /* Aborted when leaving the public flow. */ }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function beginLogin(event: MouseEvent<HTMLAnchorElement>) {
    if (!saveEstimateDraft(values)) { event.preventDefault(); setStorageFailed(true); }
  }

  return <section className="step" aria-busy={busy}>
    <h1 ref={heading} tabIndex={-1}>{t(phase === 'form' ? 'estimate.title' : phase === 'result' ? 'estimate.result' : 'estimate.loginTitle')}</h1>
    {phase === 'form' ? <>
      <p className="lede">{t('estimate.intro')}</p>
      {unavailable && <p className="banner banner-error" role="alert">{t('form.errorUnavailable')}</p>}
      <form className="card" noValidate onSubmit={event => { event.preventDefault(); void calculate(); }}>
        <div className="grid grid-3">{estimateFields.map(key => <div className="field" key={key}>
          <label htmlFor={`estimate-${key}`}>{t(`estimate.${key}`)} <span aria-hidden="true">*</span></label>
          <input id={`estimate-${key}`} name={key} type="text" inputMode="numeric" className="mono-input" autoComplete="off" required disabled={busy} maxLength={key === 'ageYears' ? 2 : key === 'termMonths' ? 3 : 16}
            value={values[key]} onChange={event => {
              clearEstimateDraft();
              const next = { ...values, [key]: event.target.value };
              setValues(next);
              onValuesChange?.(next);
            }}
            aria-invalid={invalid.includes(key) || undefined} aria-describedby={invalid.includes(key) ? `estimate-${key}-error` : undefined} />
          {invalid.includes(key) && <p className="field-error" id={`estimate-${key}-error`}>{t(`estimate.error.${key}`)}</p>}
        </div>)}</div>
        <div className="form-footer"><p className="note">{t('estimate.noSources')}</p><button className="btn btn-primary" disabled={busy}>{t(busy ? 'live.calculating' : 'estimate.calculate')}</button></div>
      </form>
    </> : <div className="card">
      {estimate && <><p className="section-label">{t('result.premium')}</p><p className="premium-value">{cop(estimate.premiumMonthly)} <span className="note">{t('result.perMonth')}</span></p>
        <dl className="facts"><div><dt>{t('estimate.amount')}</dt><dd>{cop(estimate.sumInsured)}</dd></div><div><dt>{t('estimate.termMonths')}</dt><dd>{estimate.termMonths}</dd></div></dl></>}
      <p className="banner banner-info">{t('estimate.disclaimer')}</p>
      {phase === 'result' ? <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => setPhase('login')}>{t('estimate.continue')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setPhase('form')}>{t('result.fix')}</button>
      </div> : <>
        <ol className="login-instructions"><li>{t('estimate.loginExisting')}</li><li>{t('estimate.loginNew')}</li><li>{t('estimate.loginReturn')}</li></ol>
        <p>{t('estimate.consentIntro')}</p>
        <p className="note">{t('estimate.consentChoice')}</p>
        {storageFailed && <p className="banner banner-error" role="alert">{t('estimate.storageFailed')}</p>}
        <div className="actions">
          <a className="btn btn-primary" href="/auth/login" onClick={beginLogin}>{t('estimate.signIn')}</a>
          <button type="button" className="btn btn-secondary" onClick={() => setPhase('result')}>{t('estimate.back')}</button>
          {storageFailed && <a className="btn btn-secondary" href="/auth/login">{t('estimate.signInWithoutDraft')}</a>}
        </div>
      </>}
    </div>}
  </section>;
}
