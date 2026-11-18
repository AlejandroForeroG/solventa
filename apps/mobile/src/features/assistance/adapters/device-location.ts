export async function requestDeviceLocationPermission() {
  const location = await import('expo-location');
  const permission = await location.requestForegroundPermissionsAsync();
  return permission.granted;
}

type Position = { latitude: number; longitude: number };
type Subscription = { remove(): void };
export type PositionWatcher = {
  Accuracy: { Balanced: number };
  watchPositionAsync(
    options: { accuracy: number; timeInterval: number; distanceInterval: number },
    callback: (reading: { coords: { latitude: number; longitude: number } }) => void,
  ): Promise<Subscription>;
};

const DEADLINE_MS = 10_000;

// Reads one position through a subscription, because a one-shot request cannot be cancelled: the device keeps acquiring a sensitive position after the customer withdrew the choice.
// The subscription is removed as soon as the first position arrives, the deadline passes or the signal aborts, including when the abort comes before the subscription has started.
export function readPosition(location: PositionWatcher, signal: AbortSignal): Promise<Position | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(null); return; }
    let subscription: Subscription | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      subscription?.remove();
      finish();
    };
    const onAbort = () => settle(() => resolve(null));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle(() => reject(new Error('location_deadline'))), DEADLINE_MS);
    location.watchPositionAsync({ accuracy: location.Accuracy.Balanced, timeInterval: 1000, distanceInterval: 0 },
      reading => settle(() => resolve({ latitude: reading.coords.latitude, longitude: reading.coords.longitude })))
      .then(started => { if (settled) started.remove(); else subscription = started; },
        error => settle(() => reject(error)));
  });
}

export async function readDeviceLocation(signal: AbortSignal) {
  const location = await import('expo-location');
  return readPosition(location, signal);
}
