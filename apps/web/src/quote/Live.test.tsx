import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18n, useLocale } from '../i18n/I18n';
import { LiveRegion, useAnnounce } from './Live';

function Controls() {
  const announce = useAnnounce();
  const { setLocale } = useLocale();
  return <><button onClick={() => announce('Estado anterior')}>Announce Spanish</button>
    <button onClick={() => setLocale('en-US')}>Change language</button>
    <button onClick={() => announce('Current state')}>Announce English</button></>;
}
it('removes a previous-language announcement and still announces subsequent state changes', async () => {
  render(<I18n initial="es-CO"><LiveRegion><Controls /></LiveRegion></I18n>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Announce Spanish' }));
  expect(screen.getByTestId('live-region')).toHaveTextContent('Estado anterior');
  await user.click(screen.getByRole('button', { name: 'Change language' }));
  expect(screen.getByTestId('live-region')).toBeEmptyDOMElement();
  await user.click(screen.getByRole('button', { name: 'Announce English' }));
  expect(screen.getByTestId('live-region')).toHaveTextContent('Current state');
});
