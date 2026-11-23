import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18n, useLocale } from '../i18n/I18n';
import { CalendarDateInput } from './CalendarDateInput';

function Form() {
  const [value, setValue] = useState('');
  const { setLocale } = useLocale();
  return <><label htmlFor="date">Date</label><CalendarDateInput id="date" value={value} onChange={setValue} />
    <output aria-label="API date">{value}</output><button onClick={() => setLocale('en-US')}>English</button></>;
}

describe('calendar date entry', () => {
  it('accepts a numeric keyboard and preserves the ISO calendar date when the interface language changes', async () => {
    const user = userEvent.setup(); render(<I18n initial="es-CO"><Form /></I18n>);
    const input = screen.getByLabelText('Date');
    expect(input).toHaveAccessibleDescription('Formato: DD/MM/AAAA.');
    await user.type(input, '29022024');
    expect(input).toHaveValue('29/02/2024'); expect(screen.getByLabelText('API date')).toHaveTextContent('2024-02-29');
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(input).toHaveValue('02/29/2024'); expect(screen.getByLabelText('API date')).toHaveTextContent('2024-02-29');
    expect(input).toHaveAccessibleDescription('Format: MM/DD/YYYY.');
    await user.clear(input); await user.type(input, '12311999');
    expect(screen.getByLabelText('API date')).toHaveTextContent('1999-12-31');
  });

  it('allows correction and leaves an impossible calendar date intact for authoritative validation', async () => {
    const user = userEvent.setup(); render(<I18n initial="es-CO"><Form /></I18n>);
    const input = screen.getByLabelText('Date');
    await user.type(input, '31022024');
    expect(input).toHaveValue('31/02/2024'); expect(screen.getByLabelText('API date')).toHaveTextContent('2024-02-31');
    await user.keyboard('{Backspace}3'); expect(input).toHaveValue('31/02/2023');
    await user.clear(input); expect(input).toHaveValue(''); expect(screen.getByLabelText('API date')).toBeEmptyDOMElement();
  });
});
