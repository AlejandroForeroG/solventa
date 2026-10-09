import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import type { QuoteValues } from './api';
import { fieldOrder, type FieldKey, type FieldProblem } from './fields';

type Props = {
  values: QuoteValues;
  problems: FieldProblem[];
  banner: 'none' | 'fields' | 'unavailable' | 'conflict';
  busy: boolean;
  onChange: (key: FieldKey, value: string) => void;
  onSubmit: () => void;
};

const inputs: Record<FieldKey, { label: string; type: string; inputMode?: 'numeric'; autoComplete: string; mono?: boolean }> = {
  fullName: { label: 'form.name', type: 'text', autoComplete: 'name' },
  documentNumber: { label: 'form.document', type: 'text', inputMode: 'numeric', autoComplete: 'off', mono: true },
  birthDate: { label: 'form.birthDate', type: 'date', autoComplete: 'bday', mono: true },
  city: { label: 'form.city', type: 'text', autoComplete: 'address-level2' },
  amount: { label: 'form.amount', type: 'text', inputMode: 'numeric', autoComplete: 'off', mono: true },
  termMonths: { label: 'form.term', type: 'text', inputMode: 'numeric', autoComplete: 'off', mono: true }
};

const fieldId = (key: FieldKey) => `quote-${key}`;

export function QuoteForm({ values, problems, banner, busy, onChange, onSubmit }: Props) {
  const intl = useIntl();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const first = fieldOrder.find(key => problems.some(p => p.key === key));
    if (first) document.getElementById(fieldId(first))?.focus();
  }, [problems]);

  const field = (key: FieldKey) => {
    const problem = problems.find(p => p.key === key);
    const spec = inputs[key];
    const id = fieldId(key);
    return <div className="field" key={key}>
      <label htmlFor={id}>{intl.formatMessage({ id: spec.label })} <span className="required" aria-hidden="true">*</span></label>
      <input id={id} name={key} type={spec.type} className={spec.mono ? 'mono-input' : undefined} inputMode={spec.inputMode} autoComplete={spec.autoComplete} required
        value={values[key]} onChange={event => onChange(key, event.target.value)}
        aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-error` : undefined} />
      {problem && <p className="field-error" id={`${id}-error`}>{intl.formatMessage({ id: problem.message }, problem.values)}</p>}
    </div>;
  };

  const bannerText = banner === 'fields' ? intl.formatMessage({ id: 'form.errorFields' }, { count: problems.length })
    : banner === 'unavailable' ? intl.formatMessage({ id: 'form.errorUnavailable' })
      : banner === 'conflict' ? intl.formatMessage({ id: 'form.errorConflict' }) : '';

  return <section className="step">
    <h1 ref={heading} tabIndex={-1}>{intl.formatMessage({ id: 'form.title' })}</h1>
    <p className="lede">{intl.formatMessage({ id: 'form.lede' })}</p>
    {banner !== 'none' && <div className="banner banner-error">
      <span aria-hidden="true" className="banner-icon">×</span>
      <p><strong>{intl.formatMessage({ id: 'form.errorTitle' })}</strong> {bannerText}</p>
    </div>}
    <form className="card" noValidate onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <h2 className="section-label">{intl.formatMessage({ id: 'form.sectionClient' })}</h2>
      <div className="grid">{(['fullName', 'documentNumber', 'birthDate', 'city'] as FieldKey[]).map(field)}</div>
      <h2 className="section-label">{intl.formatMessage({ id: 'form.sectionCredit' })}</h2>
      <div className="grid grid-3">
        {(['amount', 'termMonths'] as FieldKey[]).map(field)}
        <div className="field">
          <label htmlFor="quote-product">{intl.formatMessage({ id: 'form.product' })}</label>
          <input id="quote-product" type="text" readOnly value={intl.formatMessage({ id: 'form.productValue' })} />
        </div>
      </div>
      <div className="form-footer">
        <p className="note">{intl.formatMessage({ id: 'form.requiredNote' })}</p>
        <button type="submit" className="btn btn-primary" disabled={busy}>{intl.formatMessage({ id: 'form.submit' })}</button>
      </div>
    </form>
  </section>;
}
