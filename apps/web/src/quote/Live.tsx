import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

const Announce = createContext<(message: string) => void>(() => {});
export const useAnnounce = () => useContext(Announce);

// The only aria-live region in the application: every state change is announced here.
export function LiveRegion({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const announce = useCallback((next: string) => {
    // Clearing first makes a repeated identical message announce again.
    setMessage('');
    queueMicrotask(() => setMessage(next));
  }, []);
  return <Announce.Provider value={announce}>
    {children}
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="live-region">{message}</div>
  </Announce.Provider>;
}
