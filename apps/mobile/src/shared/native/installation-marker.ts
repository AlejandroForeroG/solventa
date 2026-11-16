import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

// Cache is excluded from platform backups. A missing or purged marker makes every record bound to it unusable, also on iOS reinstall.
export async function installationMarker(): Promise<string> {
  const marker = new File(Paths.cache, 'solventa-installation-v1');
  if (!marker.exists) { marker.create(); marker.write(randomUUID()); }
  return marker.text();
}
