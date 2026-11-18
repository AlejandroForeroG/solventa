import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';

const Announce = createContext<(message: string) => void>(() => {});
export const useAnnounce = () => useContext(Announce);

// Journey announcements share this region; individual controls also expose their own status.
export function LiveRegion({ children }: { children: ReactNode }) {
  const intl = useIntl();
  const locale = useRef(intl.locale);
  locale.current = intl.locale;
  const [message, setMessage] = useState({ text: '', locale: intl.locale });
  const announce = useCallback((next: string) => {
    // Clearing first makes a repeated identical message announce again.
    const language = locale.current;
    setMessage({ text: '', locale: language });
    queueMicrotask(() => setMessage({ text: next, locale: language }));
  }, []);
  return <Announce.Provider value={announce}>
    {children}
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="live-region">{message.locale === intl.locale ? message.text : ''}</div>
  </Announce.Provider>;
}
