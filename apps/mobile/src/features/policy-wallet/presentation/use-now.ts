import { useEffect, useState } from 'react';

// The current time as state, refreshed every minute and when the screen is reused: components must not read the clock while rendering,
// and a policy that starts or expires while the wallet stays open must change its validity without a manual refresh.
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
