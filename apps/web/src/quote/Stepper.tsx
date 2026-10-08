import { useIntl } from 'react-intl';

const STEPS = [1, 2, 3, 4, 5, 6, 7] as const;

export function Stepper({ current, available }: { current: number; available: number }) {
  const intl = useIntl();
  return <nav aria-label={intl.formatMessage({ id: 'stepper.label' })} className="stepper">
    {STEPS.map(n => {
      const name = intl.formatMessage({ id: `stepper.${n}` });
      const locked = n > available;
      const state = n === current ? 'current' : n < current ? 'done' : 'pending';
      return <span className="stepper-item" key={n}>
        {n > 1 && <span className={`stepper-link${n <= current ? ' stepper-link-done' : ''}`} aria-hidden="true" />}
        <button type="button" className={`stepper-step stepper-${state}`} aria-current={n === current ? 'step' : undefined}
          aria-disabled={locked ? true : undefined}
          aria-label={intl.formatMessage({ id: locked ? 'stepper.locked' : 'stepper.step' }, { n, name })}
          onClick={event => { if (locked) event.preventDefault(); }}>
          <span className="stepper-dot" aria-hidden="true">{n}</span>
          <span className="stepper-name" aria-hidden="true">{name}</span>
        </button>
      </span>;
    })}
  </nav>;
}
