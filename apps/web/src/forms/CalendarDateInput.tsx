import type { InputHTMLAttributes } from 'react';
import { useIntl } from 'react-intl';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'id'> & {
  id: string; value: string; onChange(value: string): void;
};

// Keep calendar dates independent of browser language and time zone; the API still receives ISO dates.
export function CalendarDateInput({ id, value, onChange, 'aria-describedby': describedBy, ...props }: Props) {
  const intl = useIntl();
  const spanish = intl.locale === 'es-CO';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const display = iso ? `${spanish ? iso[3] : iso[2]}/${spanish ? iso[2] : iso[3]}/${iso[1]}` : value;
  const format = spanish ? 'DD/MM/AAAA' : 'MM/DD/YYYY';
  return <>
    <input {...props} id={id} type="text" inputMode="numeric" maxLength={10} placeholder={format} value={display}
      aria-describedby={[describedBy, `${id}-format`].filter(Boolean).join(' ')} onChange={event => {
        const raw = event.target.value;
        const digits = raw.replaceAll('/', '');
        const formatted = /^\d{0,8}$/.test(digits) ? [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/') : raw;
        const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(formatted);
        onChange(local ? `${local[3]}-${spanish ? local[2] : local[1]}-${spanish ? local[1] : local[2]}` : formatted);
      }} />
    <span className="date-format note" id={`${id}-format`}>{intl.formatMessage({ id: 'form.dateFormat' }, { format })}</span>
  </>;
}
