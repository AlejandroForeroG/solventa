import { readDeviceLocation, requestDeviceLocationPermission } from '../../assistance/adapters/device-location';
import type { LocationSource } from '../application/ports';

// Asks for the foreground permission only when the customer turns the choice on, and reads one position. A refusal and a failure are different answers.
export const expoLocationSource: LocationSource = {
  async read(signal) {
    let granted: boolean;
    try { granted = await requestDeviceLocationPermission(); } catch { return { status: 'failed' }; }
    if (!granted) return { status: 'denied' };
    try {
      const position = await readDeviceLocation(signal);
      return position ? { status: 'ok', latitude: position.latitude, longitude: position.longitude } : { status: 'failed' };
    } catch { return { status: 'failed' }; }
  },
};
