import { useIntl } from 'react-intl';

const STEPS = [1, 2, 3, 4, 5, 6, 7] as const;

// Progress indicator only: steps are list items, not controls, so they add no tab stops.
export function Stepper({ current, available }: { current: number; available: number }) {
  const intl = useIntl();
  return <nav aria-label={intl.formatMessage({ id: 'stepper.label' })}>
    <ol className="stepper">
      {STEPS.map(n => {
        const name = intl.formatMessage({ id: `stepper.${n}` });
        const state = n === current ? 'current' : n < current ? 'done' : 'pending';
        return <li className={`stepper-item stepper-${state}`} key={n} aria-current={n === current ? 'step' : undefined}>
          {n > 1 && <span className={`stepper-link${n <= current ? ' stepper-link-done' : ''}`} aria-hidden="true" />}
          <span className="stepper-dot" aria-hidden="true">{n}</span>
          <span className="stepper-name" aria-hidden="true">{name}</span>
          <span className="visually-hidden">{intl.formatMessage({ id: n > available ? 'stepper.locked' : 'stepper.step' }, { n, name })}</span>
        </li>;
      })}
    </ol>
  </nav>;
}
